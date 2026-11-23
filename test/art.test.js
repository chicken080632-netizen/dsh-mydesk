// 图片二创：路由背后那几个函数的行为——找工具、改图、退化成重画、换主图、删版本。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artState, boardLayout, galleryMake, normalizeBoard, remixArt, uploadArt, variantAction } from '../src/art.js'
import plugin from '../src/host.js'
import { Store } from '../src/store.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** 一个只回答这几个名字的工具注册表；execute 决定每次调用返回什么。 */
function fakeTools({ edit, draw, execute }) {
  const definition = { name: 'x', parameters: { properties: { prompt: { type: 'string' }, aspect_ratio: { type: 'string' } } } }
  return {
    executable: name => ((name === 'edit_image' && edit) || (name === 'image_generate' && draw) ? { ...definition, name } : null),
    selectExecutor: () => ({ describe: list => ({ schemas: list.map(row => ({ name: row.name })) }) }),
    execute: async (input) => ({
      results: await Promise.all(input.calls.map(async call => ({ callId: call.id, result: await execute(call) }))),
    }),
  }
}

const ctxOf = tools => ({ get: key => (key === 'tools' ? tools : undefined) })
const ok = value => ({ isError: false, value })
const fail = message => ({ isError: true, error: { message } })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mydesk-art-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const files = join(home, 'mydesk', 'files')
  await mkdir(files, { recursive: true })
  // 卡片主图真实存在，改图才有参考图可传
  await writeFile(join(files, 'base.png'), PNG)
  const store = new Store(join(home, 'mydesk'))
  const state = await store.read()
  await store.mutate('准备数据', (draft) => {
    draft.items = [
      { id: 'picture', kind: 'image', title: '海边的图', body: '', tags: [], status: 'idea', createdAt: new Date().toISOString(), media: { src: 'mydesk/files/base.png' } },
      { id: 'note', kind: 'note', title: '一条笔记', body: '正文', tags: [], status: 'idea', createdAt: new Date().toISOString() },
      { id: 'board', kind: 'gallery', title: '配色实验', body: '', tags: [], status: 'idea', createdAt: new Date().toISOString() },
    ]
    draft.people = state.people
    return draft
  })
  return {
    home,
    files,
    store,
    async done() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('artState：没有工具时明确不可用', () => {
  assert.deepEqual(artState(ctxOf(undefined)), { ready: false, edit: false, redraw: false })
  assert.deepEqual(artState(ctxOf({ executable: () => null, execute: async () => ({}), selectExecutor: () => ({ describe: () => ({ schemas: [] }) }) })), { ready: false, edit: false, redraw: false })
})

test('artState：有 edit_image 就能拿原图改', () => {
  const tools = fakeTools({ edit: true, draw: false, execute: async () => ok({}) })
  assert.deepEqual(artState(ctxOf(tools)), { ready: true, edit: true, redraw: false })
})

test('remixArt：拿原图当参考改一版，挂到卡片上，原图不动', async () => {
  const box = await fixture()
  try {
    const out = join(box.files, 'edited.png')
    await writeFile(out, PNG)
    const seen = []
    const tools = fakeTools({
      edit: true,
      draw: false,
      execute: async (call) => {
        seen.push(JSON.parse(call.arguments))
        return ok({ savedTo: out, provider: 'demo', model: 'm1' })
      },
    })
    const data = await remixArt(ctxOf(tools), box.store, { id: 'picture', prompt: '换成傍晚', ratio: '9:16' })
    assert.equal(data.variant.mode, 'edit')
    assert.equal(data.variant.ratio, '9:16')
    assert.equal(data.variant.provider, 'demo')
    assert.match(data.variant.src, /^mydesk\/files\/a_[\w]+\.png$/)
    // 交出去的参数：参考图是卡片原图，且带上了画幅
    assert.equal(seen[0].prompt, '换成傍晚')
    assert.equal(seen[0].source_path, join(box.files, 'base.png'))
    assert.equal(seen[0].aspect_ratio, '9:16')
    // 状态里留下了这一版，主图还是原来那张
    const picture = data.state.items.find(row => row.id === 'picture')
    assert.equal(picture.media.src, 'mydesk/files/base.png')
    assert.equal(picture.art.variants.length, 1)
    assert.equal(picture.art.prompt, '换成傍晚')
    // 成品确实落进了插件自己的目录
    const names = await readdir(box.files)
    assert.equal(names.filter(name => name.startsWith('a_')).length, 1)
  } finally {
    await box.done()
  }
})

test('remixArt：改图失败时退一步按描述重画，并标明这一版不是改出来的', async () => {
  const box = await fixture()
  try {
    const out = join(box.files, 'drawn.png')
    await writeFile(out, PNG)
    const tools = fakeTools({
      edit: true,
      draw: true,
      execute: async (call) => (call.name === 'edit_image' ? fail('模型不支持参考图') : ok({ paths: [out] })),
    })
    const data = await remixArt(ctxOf(tools), box.store, { id: 'picture', prompt: '重画一张海' })
    assert.equal(data.variant.mode, 'draw')
    assert.equal(data.variant.prompt, '重画一张海')
  } finally {
    await box.done()
  }
})

test('remixArt：只接图片卡片，空提示词直接拒绝', async () => {
  const box = await fixture()
  try {
    const tools = fakeTools({ edit: true, draw: false, execute: async () => ok({}) })
    const ctx = ctxOf(tools)
    await assert.rejects(() => remixArt(ctx, box.store, { id: 'note', prompt: '改一下' }), /只有图片卡片/)
    await assert.rejects(() => remixArt(ctx, box.store, { id: 'picture', prompt: '   ' }), /先写一句/)
    await assert.rejects(() => remixArt(ctx, box.store, { id: 'nope', prompt: '改一下' }), /找不到/)
    await assert.rejects(() => remixArt(ctxOf(undefined), box.store, { id: 'picture', prompt: '改一下' }), /没有可用的图像工具/)
  } finally {
    await box.done()
  }
})

test('variantAction：换主图时一起带上画幅，删版本只删那一版', async () => {
  const box = await fixture()
  try {
    await box.store.mutate('摆一版', (draft) => {
      const row = draft.items.find(entry => entry.id === 'picture')
      row.art = { prompt: 'x', variants: [
        { id: 'v1', src: 'mydesk/files/one.png', ratio: '1:1', createdAt: new Date().toISOString() },
        { id: 'v2', src: 'mydesk/files/two.png', ratio: '16:9', createdAt: new Date().toISOString() },
      ] }
      return draft
    })
    const used = await variantAction(box.store, { id: 'picture', variantId: 'v2' }, 'use')
    const picture = used.state.items.find(row => row.id === 'picture')
    assert.equal(picture.media.src, 'mydesk/files/two.png')
    assert.deepEqual([picture.media.w, picture.media.h], [16, 9])
    assert.equal(picture.art.variants.length, 2)

    const dropped = await variantAction(box.store, { id: 'picture', variantId: 'v1' }, 'delete')
    assert.deepEqual(dropped.state.items.find(row => row.id === 'picture').art.variants.map(row => row.id), ['v2'])
    await assert.rejects(() => variantAction(box.store, { id: 'picture', variantId: 'v1' }, 'use'), /这一版已经不在了/)
  } finally {
    await box.done()
  }
})

test('HTTP：art/remix、art/use、art/delete 挂在 /mydesk 下，settings 顺带报出二创能力', async () => {
  const box = await fixture()
  try {
    let handler
    let n = 0
    const tools = fakeTools({ edit: true, draw: false, execute: async () => ok({ output: `data:image/png;base64,${PNG.toString('base64')}` }) })
    const base = { get: key => (key === 'tools' ? tools : key === 'connection' ? { requestRejection: () => undefined } : undefined) }
    const ctx = { ...base, effect: fn => fn(), webServer: { register: options => { handler = options.handler } } }
    plugin.apply(ctx)
    const request = (method, route, body = {}) => new Promise((resolve) => {
      const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
      handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
    })

    let response = await request('GET', 'settings')
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.art, { ready: true, edit: true, redraw: false })

    response = await request('POST', 'art/remix', { id: 'picture', prompt: '换个背景', ratio: '1:1' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.variant.mode, 'edit')
    assert.equal(response.body.state.items.find(row => row.id === 'picture').art.variants.length, 1)
    const variantId = response.body.variant.id
    n++

    response = await request('POST', 'art/use', { id: 'picture', variantId })
    assert.equal(response.status, 200)
    assert.match(response.body.state.items.find(row => row.id === 'picture').media.src, /^mydesk\/files\//)
    n++

    response = await request('POST', 'art/delete', { id: 'picture', variantId })
    assert.equal(response.status, 200)
    assert.equal(response.body.state.items.find(row => row.id === 'picture').art.variants.length, 0)
    n++

    response = await request('POST', 'art/remix', { id: 'note', prompt: '改一下' })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /只有图片卡片/)
    // 只有改图那一次会往 files 里落一个新文件，换主图和删版本都不落盘
    assert.equal((await readdir(box.files)).length, 2)
  } finally {
    await box.done()
  }
})

test('galleryMake：一次画几张全进图库，第一张顺手当封面，再画只追加', async () => {
  const box = await fixture()
  try {
    const seen = []
    let n = 0
    const tools = fakeTools({
      edit: false,
      draw: true,
      execute: async (call) => {
        seen.push(JSON.parse(call.arguments))
        n += 1
        const out = join(box.files, `draw-${n}.png`)
        await writeFile(out, PNG)
        return ok({ paths: [out], provider: 'demo', model: 'm1' })
      },
    })
    const ctx = ctxOf(tools)
    const data = await galleryMake(ctx, box.store, { id: 'board', prompt: '留白很多的封面', count: 3, ratio: '4:3' })
    assert.equal(data.added.length, 3)
    assert.equal(seen.length, 3)
    assert.equal(seen[0].prompt, '留白很多的封面')
    assert.equal(seen[0].aspect_ratio, '4:3')
    const board = data.state.items.find(row => row.id === 'board')
    assert.equal(board.art.variants.length, 3)
    assert.equal(board.art.prompt, '留白很多的封面')
    assert.match(board.media.src, /^mydesk\/files\/a_[\w]+\.png$/)
    assert.equal(board.media.src, data.added[0].src)

    const again = await galleryMake(ctx, box.store, { id: 'board', prompt: '再来一张', count: 1 })
    const rows = again.state.items.find(row => row.id === 'board')
    assert.equal(rows.art.variants.length, 4)
    // 封面已经定过，不会被后来的图顶掉
    assert.equal(rows.media.src, board.media.src)
    assert.equal(again.added.length, 1)
  } finally {
    await box.done()
  }
})

test('galleryMake：选中的那张当参考时走改图，交出去的是插件目录里的真文件', async () => {
  const box = await fixture()
  try {
    await box.store.mutate('先有一张', (draft) => {
      const row = draft.items.find(entry => entry.id === 'board')
      row.media = { src: 'mydesk/files/base.png' }
      row.art = { prompt: '旧的', variants: [{ id: 'v1', src: 'mydesk/files/base.png', prompt: '旧的', createdAt: new Date().toISOString() }] }
      return draft
    })
    const seen = []
    let n = 0
    const tools = fakeTools({
      edit: true,
      draw: true,
      execute: async (call) => {
        seen.push({ name: call.name, args: JSON.parse(call.arguments) })
        n += 1
        const out = join(box.files, `edited-${n}.png`)
        await writeFile(out, PNG)
        return ok({ savedTo: out })
      },
    })
    const data = await galleryMake(ctxOf(tools), box.store, { id: 'board', prompt: '接着这个风格', count: 2, source: 'v1' })
    assert.equal(data.added.length, 2)
    assert.equal(seen[0].name, 'edit_image')
    assert.equal(seen[0].args.source_path, join(box.files, 'base.png'))
    const rows = data.state.items.find(row => row.id === 'board')
    assert.equal(rows.art.variants.length, 3)
    // 参考图本身没被换成新图
    assert.equal(rows.media.src, 'mydesk/files/base.png')
  } finally {
    await box.done()
  }
})

test('galleryMake：单张失败只交成功的那些，全失败才报错', async () => {
  const box = await fixture()
  try {
    let n = 0
    const tools = fakeTools({
      edit: false,
      draw: true,
      execute: async () => {
        n += 1
        if (n === 1) return fail('这张没画出来')
        const out = join(box.files, `part-${n}.png`)
        await writeFile(out, PNG)
        return ok({ paths: [out] })
      },
    })
    const data = await galleryMake(ctxOf(tools), box.store, { id: 'board', prompt: '画两张', count: 2 })
    assert.equal(data.added.length, 1)

    const doomed = fakeTools({ edit: false, draw: true, execute: async () => fail('全挂了') })
    await assert.rejects(() => galleryMake(ctxOf(doomed), box.store, { id: 'board', prompt: '再画', count: 2 }), /全挂了/)
  } finally {
    await box.done()
  }
})

test('galleryMake：只接图库卡片，空提示词、找不到、没有工具都拒绝', async () => {
  const box = await fixture()
  try {
    const tools = fakeTools({ edit: false, draw: true, execute: async () => ok({}) })
    await assert.rejects(() => galleryMake(ctxOf(tools), box.store, { id: 'picture', prompt: '画' }), /只有图库/)
    await assert.rejects(() => galleryMake(ctxOf(tools), box.store, { id: 'board', prompt: '   ' }), /先写一句/)
    await assert.rejects(() => galleryMake(ctxOf(tools), box.store, { id: 'nope', prompt: '画' }), /找不到/)
    await assert.rejects(() => galleryMake(ctxOf(undefined), box.store, { id: 'board', prompt: '画' }), /没有可用的图像工具/)
  } finally {
    await box.done()
  }
})

test('HTTP：art/gallery 也挂在 /mydesk 下，画出来的图进图库', async () => {
  const box = await fixture()
  try {
    let handler
    let n = 0
    const tools = fakeTools({
      edit: false,
      draw: true,
      execute: async () => {
        n += 1
        const out = join(box.files, `route-${n}.png`)
        await writeFile(out, PNG)
        return ok({ paths: [out] })
      },
    })
    const base = { get: key => (key === 'tools' ? tools : key === 'connection' ? { requestRejection: () => undefined } : undefined) }
    plugin.apply({ ...base, effect: fn => fn(), webServer: { register: options => { handler = options.handler } } })
    const request = (method, route, body = {}) => new Promise((resolve) => {
      const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
      handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
    })

    let response = await request('POST', 'art/gallery', { id: 'board', prompt: '画两张海报', count: 2 })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.added.length, 2)
    assert.equal(response.body.state.items.find(row => row.id === 'board').art.variants.length, 2)

    response = await request('POST', 'art/gallery', { id: 'note', prompt: '画', count: 1 })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /只有图库/)
  } finally {
    await box.done()
  }
})

test('uploadArt：拖进来的图收进图库，第一张当封面，重复的不再收', async () => {
  const box = await fixture()
  try {
    const data = await uploadArt(ctxOf(undefined), box.store, { id: 'board', sources: ['mydesk/files/base.png', 'mydesk/files/base.png'] })
    assert.equal(data.added.length, 1)
    assert.equal(data.added[0].mode, 'upload')
    assert.equal(data.added[0].src, 'mydesk/files/base.png')
    const board = data.state.items.find(row => row.id === 'board')
    assert.equal(board.art.variants.length, 1)
    // 图库当时没有封面，收进来的第一张顺手当封面
    assert.equal(board.media.src, 'mydesk/files/base.png')
    await assert.rejects(() => uploadArt(ctxOf(undefined), box.store, { id: 'board', sources: ['mydesk/files/base.png'] }), /已经在图库里/)
  } finally {
    await box.done()
  }
})

test('uploadArt：只认插件自己目录里的图片，别的卡片不收', async () => {
  const box = await fixture()
  try {
    await assert.rejects(() => uploadArt(ctxOf(undefined), box.store, { id: 'board', sources: ['https://example.com/a.png'] }), /收不进来/)
    await assert.rejects(() => uploadArt(ctxOf(undefined), box.store, { id: 'board', sources: ['mydesk/files/../../secret.png'] }), /收不进来/)
    await assert.rejects(() => uploadArt(ctxOf(undefined), box.store, { id: 'board', sources: [] }), /没有收到图片/)
    await assert.rejects(() => uploadArt(ctxOf(undefined), box.store, { id: 'picture', sources: ['mydesk/files/base.png'] }), /只有图库可以这样收图/)
  } finally {
    await box.done()
  }
})

test('HTTP：art/add 把上传好的图收进图库', async () => {
  const box = await fixture()
  try {
    let handler
    const base = { get: key => (key === 'connection' ? { requestRejection: () => undefined } : undefined) }
    plugin.apply({ ...base, effect: fn => fn(), webServer: { register: options => { handler = options.handler } } })
    const request = (method, route, body = {}) => new Promise((resolve) => {
      const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
      handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
    })

    let response = await request('POST', 'art/add', { id: 'board', sources: ['mydesk/files/base.png'] })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.added.length, 1)
    assert.equal(response.body.state.items.find(row => row.id === 'board').media.src, 'mydesk/files/base.png')

    response = await request('POST', 'art/add', { id: 'board', sources: ['mydesk/files/base.png'] })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /已经在图库里/)
  } finally {
    await box.done()
  }
})

test('normalizeBoard：只留认识的字段，越界的坐标与宽度夹回去', () => {
  const board = normalizeBoard({
    mode: 'board',
    zoom: 99,
    pan: { x: '80', y: -40 },
    items: {
      a: { x: 10.4, y: -20.6, w: 99999, group: 'g1' },
      b: { x: 'nope', y: 1, w: 100 },
      c: { x: 5, y: 5, w: 5 },
      d: null,
    },
  })
  assert.equal(board.mode, 'board')
  assert.equal(board.zoom, 4)
  assert.deepEqual(board.pan, { x: 80, y: -40 })
  assert.deepEqual(Object.keys(board.items).sort(), ['a', 'c'])
  assert.equal(board.items.a.x, 10)
  assert.equal(board.items.a.w, 4000)
  assert.equal(board.items.a.group, 'g1')
  assert.equal(board.items.c.w, 40)
  assert.equal('d' in board.items, false)
  assert.deepEqual(normalizeBoard(undefined), { mode: 'grid', zoom: 1, pan: { x: 0, y: 0 }, items: {} })
})

test('boardLayout：把位置、缩放和预览模式存在卡片上，不占撤销位', async () => {
  const box = await fixture()
  try {
    const before = box.store.undo.length
    const saved = await boardLayout(box.store, { id: 'board', board: { mode: 'board', zoom: 1.5, pan: { x: 40, y: 12 }, items: { v1: { x: 10, y: 20, w: 300, group: 'g9' } } } })
    assert.equal(saved.board.mode, 'board')
    assert.equal(saved.board.zoom, 1.5)
    assert.deepEqual(saved.board.items.v1, { x: 10, y: 20, w: 300, group: 'g9' })
    const row = saved.state.items.find(entry => entry.id === 'board')
    assert.equal(row.art.board.zoom, 1.5)
    assert.equal(row.art.board.items.v1.x, 10)
    // 排版不进撤销栈，撤销仍然只回退内容改动
    assert.equal(box.store.undo.length, before)
    await assert.rejects(() => boardLayout(box.store, { id: 'nope', board: {} }), /找不到/)
    await assert.rejects(() => boardLayout(box.store, { id: 'picture', board: {} }), /只有图库/)
  } finally {
    await box.done()
  }
})

test('HTTP：art/board 挂在 /mydesk 下', async () => {
  const box = await fixture()
  try {
    let handler
    const tools = fakeTools({ edit: false, draw: true, execute: async () => ok({}) })
    const base = { get: key => (key === 'tools' ? tools : key === 'connection' ? { requestRejection: () => undefined } : undefined) }
    plugin.apply({ ...base, effect: fn => fn(), webServer: { register: options => { handler = options.handler } } })
    const request = (method, route, body = {}) => new Promise((resolve) => {
      const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
      handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
    })

    let response = await request('POST', 'art/board', { id: 'board', board: { mode: 'board', zoom: 2, items: { v1: { x: 5, y: 6, w: 280 } } } })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.board.zoom, 2)
    assert.equal(response.body.state.items.find(entry => entry.id === 'board').art.board.items.v1.w, 280)

    response = await request('POST', 'art/board', { id: 'note', board: {} })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /只有图库/)
  } finally {
    await box.done()
  }
})

// ---- 图库「铺开」的吸附计算 ----
import { snapDrag, snapDragFrom } from '../client/snap.js'

test('吸附：左边缘靠近别的图右边缘就贴上去，并给出参考线', () => {
  const boxes = {
    a: { x: 0, y: 0, w: 100, h: 100 },
    b: { x: 500, y: 40, w: 100, h: 100 },
  }
  // b 往左拖 393：左边缘到 107，离 a 的右边缘 100 只差 7，应当吸住
  const snapped = snapDrag({ boxes, moving: ['b'], dx: -393, dy: 0 })
  assert.equal(snapped.dx, -400)
  assert.equal(snapped.guide.x, 100)
  // 拖 391（差 9）就超出吸附距离，原样返回
  const free = snapDrag({ boxes, moving: ['b'], dx: -391, dy: 0 })
  assert.equal(free.dx, -391)
  assert.equal(free.guide, null)
})

test('吸附：中线对中线，上下也一起看', () => {
  const boxes = {
    a: { x: 0, y: 0, w: 100, h: 100 },
    b: { x: 300, y: 300, w: 100, h: 80 },
  }
  // 停在两块都不沾的位置：左边缘 60、上边缘 37，离 a 的 0/50/100 都超过 7
  const free = snapDrag({ boxes, moving: ['b'], dx: -240, dy: -263 })
  assert.equal(free.guide, null)
  // 左边缘挪到 53 就离 a 的中线 50 只有 3，横着吸住
  const mid = snapDrag({ boxes, moving: ['b'], dx: -247, dy: -263 })
  assert.equal(mid.dx, -250)
  assert.equal(mid.guide.x, 50)
  // 往上拖到 104（差 4）就吸到 a 的下边缘 100
  const ledge = snapDrag({ boxes, moving: ['b'], dx: -247, dy: -196 })
  assert.equal(ledge.dy, -200)
  assert.equal(ledge.guide.y, 100)
})

test('吸附：多选时按选区包围盒对齐，缩放越大手感距离越小', () => {
  const boxes = {
    a: { x: 0, y: 0, w: 100, h: 100 },
    b: { x: 400, y: 0, w: 100, h: 100 },
    c: { x: 400, y: 200, w: 100, h: 100 },
  }
  const one = snapDrag({ boxes, moving: ['b', 'c'], dx: -296, dy: 0 })
  assert.equal(one.dx, -300)
  // 同一个 6px 偏差：放大到 2 倍时留给世界的吸附距离只有 3.5，就不吸了
  const zoomed = snapDrag({ boxes, moving: ['b', 'c'], dx: -294, dy: 0, scale: 2 })
  assert.equal(zoomed.dx, -294)
})

test('吸附：画布上只有它自己时不动', () => {
  const boxes = { a: { x: 10, y: 10, w: 100, h: 100 } }
  assert.deepEqual(snapDrag({ boxes, moving: ['a'], dx: 3, dy: 4 }), { dx: 3, dy: 4, guide: null, lock: [null, null] })
})

test('吸附：吸住之后不会在两个相邻基准之间来回跳（抖动）', () => {
  // a 的右边在 300，c 的左边在 302：指针在 301 / 302 之间来回一像素时，
  // 不锁的话会 300 → 302 → 300 地弹（这就是用户说的鬼畜抖动）。
  const boxes = {
    a: { x: 200, y: 0, w: 100, h: 100 },
    c: { x: 302, y: 400, w: 100, h: 100 },
    b: { x: 400, y: 200, w: 100, h: 100 },
  }
  let lock = [null, null]
  const seen = []
  for (const dx of [-99, -98, -99, -98, -99]) {
    const out = snapDrag({ boxes, moving: ['b'], dx, dy: 0, lock })
    lock = out.lock
    seen.push(out.dx)
  }
  // 每一下都还是贴在 300，一次都没跳到 302
  assert.deepEqual(seen, [-100, -100, -100, -100, -100])
  assert.deepEqual(lock[0], { anchor: 0, target: 300 })

  // 拉出吸附距离才放手：左边到了 309，最近的变成 c 的左边 302
  const away = snapDrag({ boxes, moving: ['b'], dx: -91, dy: 0, lock })
  assert.equal(away.dx, -98)
  assert.deepEqual(away.lock[0], { anchor: 0, target: 302 })

  // 再远一点就完全不吸了
  const free = snapDrag({ boxes, moving: ['b'], dx: -80, dy: 0, lock })
  assert.equal(free.dx, -80)
  assert.equal(free.guide, null)
})

test('吸附：算包围盒要用按下时的位置，不能把位移重复加一遍', () => {
  // c 的右边在 500；b 已经跟着手指走了 100（当前位置 500，按下时是 400）。
  // 用当前位置算包围盒会得到 500 + 97 = 597，吸不上；正确算法是 400 + 97 = 497，吸到 500。
  const boxes = {
    a: { x: 0, y: 0, w: 100, h: 100 },
    c: { x: 400, y: 200, w: 100, h: 100 },
    b: { x: 500, y: 0, w: 100, h: 100 },
  }
  const start = { b: { x: 400, y: 0 } }
  const out = snapDragFrom({ boxes, start, moving: ['b'], dx: 97, dy: 0 })
  assert.equal(out.dx, 100)
  assert.equal(out.guide.x, 500)
  // 拖到 60 以外时两边都算不吸，位置就是手指位置
  const free = snapDragFrom({ boxes, start, moving: ['b'], dx: 60, dy: 0 })
  assert.equal(free.dx, 60)
})
