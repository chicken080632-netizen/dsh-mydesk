// 对话里的参考图：只认插件目录里的图、最多 4 张，能交给模型就真看图，交不了就如实说。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { callModel } from '../src/ai.js'
import plugin from '../src/host.js'
import { MAX_REFS, refsBlock, resolveRefs } from '../src/refs.js'
import { Store } from '../src/store.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

async function fixture(count = 6) {
  const home = await mkdtemp(join(tmpdir(), 'mydesk-refs-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const files = join(home, 'mydesk', 'files')
  await mkdir(files, { recursive: true })
  for (let index = 0; index < count; index += 1) await writeFile(join(files, `p${index}.png`), PNG)
  const store = new Store(join(home, 'mydesk'))
  return {
    home,
    files,
    store,
    srcs: Array.from({ length: count }, (_, index) => `mydesk/files/p${index}.png`),
    async done() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** attachments 服务的最小替身：返回一个能当 image block 用的附件引用。 */
const attachmentsOf = (calls = []) => ({
  async saveImage(input) {
    calls.push(input)
    return { attachmentId: `att_${calls.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
  },
})

test('resolveRefs：只认插件目录里的图，去重，最多 4 张', async () => {
  const box = await fixture()
  try {
    const ctx = { get: () => undefined }
    const out = await resolveRefs(ctx, [
      ...box.srcs,
      box.srcs[0],
      'https://example.com/a.png',
      'mydesk/files/../secret.png',
      '',
    ])
    assert.equal(out.refs.length, MAX_REFS)
    assert.deepEqual(out.refs.map(row => row.src), box.srcs.slice(0, MAX_REFS))
    assert.deepEqual(out.blocks, [])
    // 没给标签时按「第 n 张」编号
    assert.equal(out.refs[0].label, '第 1 张')
  } finally {
    await box.done()
  }
})

test('resolveRefs：能存成附件就给模型带上图，标签和提示词一起带回来', async () => {
  const box = await fixture(2)
  try {
    const calls = []
    const ctx = { get: key => (key === 'attachments' ? attachmentsOf(calls) : undefined) }
    const out = await resolveRefs(ctx, [
      { src: box.srcs[0], label: '封面', prompt: '深色背景' },
      { src: box.srcs[1] },
    ])
    assert.equal(out.refs.length, 2)
    assert.equal(out.refs[0].label, '封面')
    assert.equal(out.refs[0].prompt, '深色背景')
    assert.equal(out.refs[1].label, '第 2 张')
    assert.equal(out.blocks.length, 2)
    assert.equal(out.blocks[0].type, 'image')
    assert.equal(out.blocks[0].attachment.attachmentId, 'att_1')
    assert.equal(calls[0].mediaType, 'image/png')
    assert.equal(calls[0].name, 'p0.png')
  } finally {
    await box.done()
  }
})

test('refsBlock：说清附了哪几张、当初用的提示词', () => {
  assert.equal(refsBlock([]), '')
  const text = refsBlock([
    { src: 'mydesk/files/a.png', label: '第 1 张', prompt: '深色背景' },
    { src: 'mydesk/files/b.png', label: '封面', prompt: '' },
  ])
  assert.match(text, /^<references>用户随这条消息附了 2 张参考图/)
  assert.match(text, /第 1 张：第 1 张（mydesk\/files\/a\.png，画它时用的提示词：深色背景）/)
  assert.match(text, /第 2 张：封面（mydesk\/files\/b\.png）/)
})

/** 只回答一段文字的模型：记录每次真正发出去的 content，方便断言有没有带图。 */
function llmOf(modalities, { failFirst = false } = {}) {
  const seen = []
  const llm = {
    async prepareCall() {
      return {
        inputModalities: modalities,
        config: {},
        stream: async function* (request) {
          seen.push(request)
          if (failFirst && seen.length === 1) throw new Error('image input is not supported')
          yield { type: 'text-delta', text: '好的' }
        },
      }
    },
  }
  const ctx = {
    get(key) {
      if (key === 'llm') return llm
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  return { ctx, seen }
}

test('callModel：模型声明能看图时，把图一起发过去', async () => {
  const { ctx, seen } = llmOf(['text', 'image'])
  const out = await callModel(ctx, {
    system: 's',
    user: 'u',
    images: [{ type: 'image', attachment: { attachmentId: 'att_1' } }],
  })
  assert.equal(out.text, '好的')
  assert.equal(out.sawImages, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].messages[0].content.length, 2)
  assert.equal(seen[0].messages[0].content[1].type, 'image')
})

test('callModel：模型只收文字时不发图，并如实说没看到', async () => {
  const { ctx, seen } = llmOf(['text'])
  const out = await callModel(ctx, {
    system: 's',
    user: 'u',
    images: [{ type: 'image', attachment: { attachmentId: 'att_1' } }],
  })
  assert.equal(out.sawImages, false)
  assert.equal(seen[0].messages[0].content.length, 1)
})

test('callModel：没声明能力时先试带图，被拒再退回纯文字', async () => {
  const { ctx, seen } = llmOf(undefined, { failFirst: true })
  const out = await callModel(ctx, {
    system: 's',
    user: 'u',
    images: [{ type: 'image', attachment: { attachmentId: 'att_1' } }],
  })
  assert.equal(out.text, '好的')
  assert.equal(out.sawImages, false)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].messages[0].content.length, 2)
  assert.equal(seen[1].messages[0].content.length, 1)
})

test('HTTP：chat 带 refs 时把缩略图记进对话，模型看不到图就说清楚', async () => {
  const box = await fixture(1)
  try {
    let handler
    const { ctx: llmCtx } = llmOf(['text'])
    const calls = []
    const ctx = {
      get(key) {
        if (key === 'connection') return { requestRejection: () => undefined }
        if (key === 'llm') return llmCtx.get('llm')
        if (key === 'agentDefaultModel') return llmCtx.get('agentDefaultModel')
        if (key === 'attachments') return attachmentsOf(calls)
        return undefined
      },
      effect: fn => fn(),
      webServer: { register: options => { handler = options.handler } },
    }
    plugin.apply(ctx)
    const request = body => new Promise((resolve) => {
      const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
      handler({ method: 'POST', url: '/mydesk/chat', headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
    })

    const response = await request({ message: '看看这张', refs: [box.srcs[0]] })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const chat = response.body.state.chat
    const user = chat.find(row => row.role === 'user')
    assert.deepEqual(user.refs, [{ src: box.srcs[0], label: '第 1 张' }])
    const answer = chat[chat.length - 1]
    assert.equal(answer.role, 'assistant')
    assert.match(answer.notice, /不能看图/)
  } finally {
    await box.done()
  }
})
