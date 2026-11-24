import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { imageTool, generateToolImage } from '../src/image-tool.js'
import { bridgeGenerate, bridgeRoot, bridgeTool } from '../src/bridge.js'
import { imageReady, publicSettings, Settings } from '../src/settings.js'
import { Producer } from '../src/produce.js'
import { Store } from '../src/store.js'
import plugin from '../src/host.js'

const PNG = Buffer.from('89504e470d0a1a0a000000000000', 'hex')
const DEFINITION = { parameters: { properties: { prompt: { type: 'string' } } }, output: { schema: { properties: { paths: { type: 'array' } } } } }
function context(execute, names = ['image_generate']) {
  const tools = {
    executable: name => names.includes(name) ? { ...DEFINITION, name } : undefined,
    selectExecutor: () => ({ describe: definitions => ({ schemas: definitions }) }),
    execute,
  }
  return { get: name => name === 'tools' ? tools : undefined }
}
const success = (batch, path) => ({ results: [{ callId: batch.calls[0].id, result: { isError: false, value: { paths: [path] } } }] })

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mydesk-tool-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const root = join(dir, 'plugins', 'subscriptions', 'images')
    await mkdir(root, { recursive: true })
    const path = join(root, 'generated.png')
    await writeFile(path, PNG)
    await run({ dir, root, path })
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    await rm(dir, { recursive: true, force: true })
  }
}

test('tool discovery is optional, dynamic, schema-checked and alias-first; it never generates', () => {
  const ctx = context(() => assert.fail('discovery must not generate'), ['image_generate', 'dsh_subscriptions_image_generate'])
  assert.equal(imageTool(ctx).name, 'dsh_subscriptions_image_generate')
  assert.equal(imageTool({ get: () => undefined }), null)
  assert.equal(imageTool({ get: () => ({ get() {}, execute() {} }) }), null)
  assert.equal(imageTool({ get: () => ({ executable: () => ({}), execute() {} }) }), null)
  assert.equal(imageTool(context(() => {}, [])), null)
  const unavailable = context(() => assert.fail('discovery must not generate'))
  unavailable.get('tools').selectExecutor = () => { throw new Error('executor unloaded') }
  assert.equal(imageTool(unavailable), null)
  const ptc = context(() => assert.fail('PTC must not receive direct image calls'))
  ptc.get('tools').selectExecutor = () => ({ describe: () => ({ schemas: [{ name: 'run_code' }] }) })
  assert.equal(imageTool(ptc), null)
  assert.equal(imageReady({ image: { source: 'tool' } }, Boolean(imageTool(ptc))), false)
  const restored = ctx.get('tools').selectExecutor
  ctx.get('tools').selectExecutor = () => ({ describe() { throw new Error('runtime unloaded') } })
  assert.equal(imageTool(ctx), null)
  ctx.get('tools').selectExecutor = restored
  assert.equal(imageTool(ctx).name, 'dsh_subscriptions_image_generate')
})

test('legacy settings default to HTTP; tool source needs runtime capability, not an API key', async () => fixture(async ({ dir }) => {
  const settings = new Settings(dir)
  assert.equal((await settings.read()).image.source, 'http')
  await settings.update({ image: { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'secret' } })
  assert.equal(imageReady(await settings.read()), true)
  await settings.update({ image: { source: 'tool' } })
  let saved = await settings.read()
  assert.equal(imageReady(saved), false)
  assert.equal(imageReady(saved, true), true)
  assert.equal(publicSettings(saved, true).imageToolAvailable, true)
  assert.equal(publicSettings(saved, true).imageReady, true)
  assert.ok(!JSON.stringify(publicSettings(saved, true)).includes('secret'))
  await assert.rejects(settings.update({ image: { source: 'unknown' } }), /来源无效/)
  await settings.update({ image: { source: 'http' } })
  saved = await settings.read()
  assert.equal(saved.image.apiKey, 'secret')
  assert.equal(imageReady(saved), true)
  // Old settings files have no source and must retain their original HTTP configuration.
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ image: { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'old' } }))
  assert.equal((await settings.read()).image.source, 'http')
  assert.equal(imageReady(await settings.read()), true)
}))

test('switching sources preserves HTTP parameters and uses independently validated tool settings', async () => fixture(async ({ dir, path }) => {
  const settings = new Settings(dir)
  await settings.update({ image: { source: 'http', baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'secret', size: '1024x768', quality: 'standard' } })
  let saved = await settings.update({ image: { source: 'tool' } })
  assert.equal(saved.image.toolSize, '1536x1024')
  assert.equal(saved.image.toolQuality, '')
  let calls = 0
  const ctx = context(async batch => {
    calls++
    assert.deepEqual(JSON.parse(batch.calls[0].arguments), { prompt: 'p', size: '1536x1024' })
    return success(batch, path)
  })
  await generateToolImage(ctx, saved.image, 'p')
  assert.equal(calls, 1)
  for (const image of [{ toolSize: '1024x768' }, { toolQuality: 'standard' }, { toolSize: null }, { toolQuality: false }]) {
    await assert.rejects(settings.update({ image }), error => error.status === 400)
    await assert.rejects(generateToolImage(ctx, { ...saved.image, ...image }, 'p'))
  }
  assert.equal(calls, 1)
  saved = await settings.update({ image: { toolSize: '', toolQuality: '', source: 'http' } })
  assert.equal(saved.image.size, '1024x768')
  assert.equal(saved.image.quality, 'standard')
  assert.equal(saved.image.apiKey, 'secret')
  assert.equal(saved.image.baseUrl, 'https://example.com/v1')
  const omit = context(async batch => {
    assert.deepEqual(JSON.parse(batch.calls[0].arguments), { prompt: 'p' })
    return success(batch, path)
  })
  await generateToolImage(omit, saved.image, 'p')
}))

test('uses public batch execution and canonical value, imports image, never passes API credentials or fake agent', async () => fixture(async ({ path }) => {
  let calls = 0
  const ctx = context(async batch => {
    calls++
    assert.deepEqual(Object.keys(batch).sort(), ['calls', 'signal'])
    const call = batch.calls[0]
    assert.equal(call.type, 'tool-call')
    assert.match(call.id, /^mydesk:/)
    assert.equal(call.name, 'image_generate')
    assert.deepEqual(JSON.parse(call.arguments), { prompt: 'paper boat', size: '1536x1024', quality: 'high' })
    assert.equal(batch.signal.aborted, false)
    return success(batch, path)
  })
  const result = await generateToolImage(ctx, { apiKey: 'never-forward', model: 'ignored', extra: '{"prompt":"ignored"}', size: '1024x768', quality: 'standard', toolSize: '1536x1024', toolQuality: 'high' }, 'paper boat')
  assert.deepEqual(result, { buffer: PNG, ext: '.png' })
  assert.equal(calls, 1)
}))

test('tool errors fail closed without retries or HTTP fallback; executor incompatibility is explicit', async () => {
  let calls = 0
  const ctx = context(async batch => {
    calls++
    return { results: [{ callId: batch.calls[0].id, result: { isError: true, error: { message: 'quota 429' } } }] }
  })
  await assert.rejects(generateToolImage(ctx, {}, 'p'), e => e.permanent && /quota 429/.test(e.message))
  assert.equal(calls, 1)
  const ptc = context(async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: true, error: { message: 'unknown', info: { code: 'UNKNOWN_TOOL' } } } }] }))
  await assert.rejects(generateToolImage(ptc, {}, 'p'), /原生工具执行器/)
  await assert.rejects(generateToolImage(context(async () => { throw new Error('executor missing') }), {}, 'p'), /executor missing/)
  await assert.rejects(generateToolImage(context(async () => { throw Object.freeze(new Error('frozen 429')) }), {}, 'p'), e => e.permanent && e.message === 'frozen 429')
  await assert.rejects(generateToolImage(context(async () => { throw 'plain failure' }), {}, 'p'), e => e.permanent && e.message === 'plain failure')
  await assert.rejects(generateToolImage(context(async () => ({ results: [] })), {}, 'p'), /没有返回图片/)
  await assert.rejects(generateToolImage(context(async batch => ({ results: [{ callId: 'wrong', result: { isError: false, value: { paths: ['ignored'] } } }] })), {}, 'p'), /没有返回图片/)
  await assert.rejects(generateToolImage(context(() => assert.fail('must not dispatch'), []), {}, 'p'), /未找到/)
})

test('validates tool arguments before upstream; abort propagates and pre-aborted calls do not dispatch', async () => {
  const ctx = context(() => assert.fail('must not dispatch'))
  await assert.rejects(generateToolImage(ctx, { toolSize: '2048x2048' }, 'p'), /尺寸/)
  await assert.rejects(generateToolImage(ctx, { toolQuality: 'ultra' }, 'p'), /质量/)
  await assert.rejects(generateToolImage(ctx, {}, 'p', { signal: AbortSignal.abort() }), { name: 'AbortError' })
  const controller = new AbortController()
  const aborting = context(async batch => {
    controller.abort()
    assert.equal(batch.signal.aborted, true)
    batch.signal.throwIfAborted()
  })
  await assert.rejects(generateToolImage(aborting, {}, 'p', { signal: controller.signal }), { name: 'AbortError' })
})

test('only accepts actual images within subscription output directory, not arbitrary paths, URLs or oversized files', async () => fixture(async ({ dir, root, path }) => {
  const attempt = candidate => generateToolImage(context(async batch => success(batch, candidate)), {}, 'p')
  await assert.rejects(attempt('relative.png'), /路径无效/)
  await assert.rejects(attempt('https://example.com/image.png'), /路径无效/)
  const outside = join(dir, 'outside.png')
  await writeFile(outside, PNG)
  await assert.rejects(attempt(outside), /路径无效/)
  const sibling = join(dir, 'plugins', 'subscriptions', 'images-sibling')
  await mkdir(sibling)
  await writeFile(join(sibling, 'image.png'), PNG)
  await assert.rejects(attempt(join(sibling, 'image.png')), /路径无效/)
  await writeFile(path, '<html>not an image</html>')
  await assert.rejects(attempt(path), /不是图片/)
  await writeFile(path, Buffer.alloc(40_000_001))
  await assert.rejects(attempt(path), /太大/)
  // Directory output must not be imported as a file.
  await assert.rejects(attempt(root))
}))

test('realpath prevents an output directory symlink from exposing another directory', async t => fixture(async ({ dir, root }) => {
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.png'), PNG)
  const escape = join(root, 'escape')
  try { await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (e) { if (e.code === 'EPERM') return t.skip('symlinks unavailable'); throw e }
  try {
    await assert.rejects(generateToolImage(context(async batch => success(batch, join(escape, 'private.png'))), {}, 'p'), /路径无效/)
  } finally {
    if (process.platform === 'win32') await rmdir(escape)
    else await unlink(escape)
  }
}))

test('Producer readiness uses injected capability and tool failures are not retried on 429 text', async () => fixture(async ({ dir, path }) => {
  const store = new Store(join(dir, 'desk'))
  await store.read()
  const settings = new Settings(store.root)
  await settings.update({ image: { source: 'tool' }, imageCount: 1, shotCount: 1 })
  const ctx = context(async batch => success(batch, path))
  const producer = new Producer({ store, settings, ready: saved => imageReady(saved, Boolean(imageTool(ctx))), generate: (image, prompt, options) => generateToolImage(ctx, image, prompt, options), callText: async () => { throw new Error('offline') } })
  const state = await store.read()
  const id = state.items[0].id
  await store.mutate('test', draft => { draft.items.find(row => row.id === id).production = {}; return draft })
  await producer.run(id, { controller: new AbortController(), planText: '', text: '' })
  const done = (await store.read()).items.find(row => row.id === id).production
  assert.equal(done.status, 'done')
  assert.equal(done.cover.status, 'done')
  assert.ok(done.cover.src)
  assert.equal(done.images[0].status, 'done')
  assert.equal(done.shots[0].status, 'done')
  assert.equal(done.needsProvider, undefined)
  let redrawn = 0
  const generate = producer.generate
  producer.generate = async (...args) => { redrawn++; return generate(...args) }
  await producer.regenerate(id, 'image:0')
  // regenerate is intentionally detached; drain this test's asset before cleanup.
  while (producer.assets.size) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(redrawn, 1)
  assert.equal((await store.read()).items.find(row => row.id === id).production.images[0].status, 'done')
  assert.equal(producer.ready(await settings.read()), true)
  let attempts = 0
  producer.generate = async () => { attempts++; throw Object.assign(new Error('429'), { permanent: true }) }
  await assert.rejects(producer.generateWithRetry({}, 'p'), /429/)
  assert.equal(attempts, 1)
}))

test('authenticated settings/test and readiness use the same tool backend; HTTP source never calls tools', async () => fixture(async ({ path }) => {
  let handler, generated = 0
  const ctx = context(async batch => { generated++; return success(batch, path) })
  const baseGet = ctx.get
  ctx.get = name => name === 'connection' ? { requestRejection: () => undefined } : baseGet(name)
  ctx.effect = fn => fn()
  ctx.webServer = { register: options => { handler = options.handler } }
  plugin.apply(ctx)
  const request = (method, route, body = {}) => new Promise(resolve => {
    const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
    handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
  })
  let response = await request('GET', 'settings')
  assert.equal(response.body.image.source, 'http')
  assert.equal(response.body.imageToolAvailable, true)
  assert.equal(response.body.imageReady, false)
  response = await request('POST', 'settings/test')
  assert.equal(response.status, 400)
  assert.match(response.body.error, /接口地址、模型和密钥/)
  assert.equal(generated, 0)
  await request('GET', 'state')
  response = await request('POST', 'settings', { image: { source: 'tool' } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.imageReady, true)
  response = await request('POST', 'settings/test')
  assert.equal(response.status, 200)
  assert.match(response.body.src, /^mydesk\/files\//)
  assert.equal(generated, 1)
  ctx.get = name => name === 'tools' ? undefined : name === 'connection' ? { requestRejection: () => undefined } : undefined
  response = await request('GET', 'settings')
  assert.equal(response.body.imageReady, false)
  response = await request('POST', 'settings/test')
  assert.equal(response.status, 400)
  assert.match(response.body.error, /未找到订阅生图工具/)
  assert.equal(generated, 1)
}))

// 「桥接到 image-gen」现在是内置的：不走 image_generate 这个外部中转工具，
// 而是直接用只带 cwd 的替身 agent 调 dsh-image-gen 的 generate_image。
const DRAW_DEFINITION = {
  name: 'generate_image',
  parameters: {
    properties: {
      prompt: { type: 'string' },
      size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'] },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
    },
  },
  output: { schema: { properties: { attachment: { type: 'object' } } } },
}
function drawContext(execute, names = ['generate_image']) {
  const tools = {
    executable: name => names.includes(name) ? { ...DRAW_DEFINITION, name } : undefined,
    selectExecutor: () => ({ describe: definitions => ({ schemas: definitions }) }),
    execute,
  }
  return { get: name => name === 'tools' ? tools : undefined }
}

test('内置桥接：把请求直接转给 generate_image，并从插件数据目录读回成品', async () => fixture(async ({ dir }) => {
  const outDir = join(dir, 'mydesk', 'generated')
  await mkdir(outDir, { recursive: true })
  const out = join(outDir, 'drawn.png')
  await writeFile(out, PNG)
  const seen = []
  const ctx = drawContext(async batch => {
    seen.push(batch)
    return { results: [{ callId: batch.calls[0].id, result: { isError: false, value: { savedTo: out, provider: 'chatgpt-sub', model: 'gpt-image-2.6-flare' } } }] }
  })

  // 只认 generate_image：订阅工具和别名 image_generate 都不算桥接
  assert.equal(bridgeRoot(), join(dir, 'mydesk'))
  assert.equal(bridgeTool(ctx).name, 'generate_image')
  assert.equal(bridgeTool(context(() => assert.fail('must not dispatch'), ['dsh_subscriptions_image_generate', 'image_generate'])), null)
  assert.equal(bridgeTool({ get: () => undefined }), null)

  const drawn = await bridgeGenerate(ctx, { toolSize: '1536x1024', toolQuality: 'high' }, 'paper boat')
  assert.equal(drawn.ext, '.png')
  assert.ok(drawn.buffer.length >= 8)
  assert.deepEqual(seen[0].calls.map(call => call.name), ['generate_image'])
  assert.deepEqual(JSON.parse(seen[0].calls[0].arguments), { prompt: 'paper boat', size: '1536x1024', quality: 'high' })
  // 工作台没有聊天会话：靠只带 cwd 的替身 agent 把插件数据目录当会话工作区
  assert.equal(seen[0].agent?.session?.header?.cwd, join(dir, 'mydesk'))

  // 声明里没有这个值时退 auto；连 auto 都没有就不发这个参数
  const loose = drawContext(async batch => {
    seen.push(batch)
    return { results: [{ callId: batch.calls[0].id, result: { isError: false, value: { output: `data:image/png;base64,${PNG.toString('base64')}` } } }] }
  })
  await bridgeGenerate(loose, { toolSize: '2048x2048', toolQuality: 'ultra' }, 'x')
  assert.deepEqual(JSON.parse(seen[1].calls[0].arguments), { prompt: 'x', size: 'auto', quality: 'auto' })

  // 没装 dsh-image-gen：提示里点明缺的是 generate_image
  await assert.rejects(bridgeGenerate(drawContext(() => assert.fail('must not dispatch'), []), {}, 'p'), /generate_image/)

  // 成品既不在插件数据目录里、也没有 data URL：明确报错，不做越界读取
  await writeFile(join(dir, 'outside.png'), PNG)
  const stray = drawContext(async batch => ({ results: [{ callId: batch.calls[0].id, result: { isError: false, value: { savedTo: join(dir, 'outside.png') } } }] }))
  await assert.rejects(bridgeGenerate(stray, {}, 'p'), /没有返回图片/)
}))

test('桥接模式的 HTTP 面板：内置桥接的就绪状态与试画', async () => fixture(async ({ dir }) => {
  const outDir = join(dir, 'mydesk', 'generated')
  await mkdir(outDir, { recursive: true })
  const out = join(outDir, 'drawn.png')
  await writeFile(out, PNG)
  let handler
  const seen = []
  const ctx = drawContext(async batch => {
    seen.push(batch.calls[0])
    return { results: [{ callId: batch.calls[0].id, result: { isError: false, value: { savedTo: out } } }] }
  })
  const baseGet = ctx.get
  ctx.get = name => name === 'connection' ? { requestRejection: () => undefined } : baseGet(name)
  ctx.effect = fn => fn()
  ctx.webServer = { register: options => { handler = options.handler } }
  plugin.apply(ctx)
  const request = (method, route, body = {}) => new Promise(resolve => {
    const res = { headersSent: false, setHeader() {}, end(raw) { resolve({ status: this.statusCode, body: JSON.parse(raw) }) } }
    handler({ method, url: `/mydesk/${route}`, headers: { 'sec-fetch-site': 'same-origin' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
  })

  let response = await request('GET', 'settings')
  assert.equal(response.body.imageBridgeAvailable, true)
  // 老的两档在这里都不存在：桥接不依赖订阅工具，也不依赖别名 image_generate
  assert.equal(response.body.imageToolAvailable, false)
  // 先读一次 state，让 Store 把目录建出来，否则写 settings 会撞上目录不存在
  await request('GET', 'state')
  const saved = await new Settings(join(dir, 'mydesk')).read()
  const bridged = { ...saved, image: { ...saved.image, source: 'bridge' } }
  assert.equal(imageReady(bridged, { tool: true, bridge: false }), false)
  assert.equal(imageReady(bridged, { tool: false, bridge: true }), true)
  assert.equal(imageReady(bridged, true), true)
  assert.equal(publicSettings(bridged, { tool: false, bridge: true }).imageBridgeAvailable, true)

  response = await request('POST', 'settings', { image: { source: 'bridge' } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.image.source, 'bridge')
  assert.equal(response.body.imageReady, true)
  response = await request('POST', 'settings/test')
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.match(response.body.src, /^mydesk\/files\//)
  assert.deepEqual(seen.map(call => call.name), ['generate_image'])

  // 换一台没装 dsh-image-gen 的机器：面板说没有桥接，试画给出提示
  const fallback = drawContext(async () => assert.fail('must not dispatch'), [])
  const baseFallback = fallback.get
  fallback.get = name => name === 'connection' ? { requestRejection: () => undefined } : baseFallback(name)
  fallback.effect = fn => fn()
  fallback.webServer = { register: options => { handler = options.handler } }
  plugin.apply(fallback)
  response = await request('GET', 'settings')
  assert.equal(response.body.imageBridgeAvailable, false)
  assert.equal(response.body.imageReady, false)
  response = await request('POST', 'settings/test')
  assert.equal(response.status, 400)
  assert.match(response.body.error, /generate_image/)
  assert.equal(seen.length, 1)
}))

test('桥接直接调工具体，不经过 tools.execute（Auto 复核会读真实会话，替身 agent 撑不住）', async () => fixture(async ({ dir }) => {
  const outDir = join(dir, 'mydesk', 'generated')
  await mkdir(outDir, { recursive: true })
  const out = join(outDir, 'direct.png')
  await writeFile(out, PNG)
  let seen
  const tools = {
    executable: name => name === 'generate_image' ? { ...DRAW_DEFINITION, name, execute: async (args, exec) => { seen = { args, exec }; return { savedTo: out } } } : undefined,
    selectExecutor: () => ({ describe: definitions => ({ schemas: definitions }) }),
    execute: () => assert.fail('批量通道会触发 tools/pre-execute 的 Auto 复核，不该走'),
  }
  const drawn = await bridgeGenerate({ get: name => name === 'tools' ? tools : undefined }, { toolQuality: 'high' }, 'paper boat')
  assert.equal(drawn.ext, '.png')
  assert.deepEqual(seen.args, { prompt: 'paper boat', quality: 'high' })
  // 替身 agent 的 cwd 就是插件数据目录：image-gen 据此把成品写进 mydesk 里
  assert.equal(seen.exec.agent.session.header.cwd, join(dir, 'mydesk'))
  assert.equal(seen.exec.name, 'generate_image')
  assert.equal(typeof seen.exec.deferContext, 'function')
}))
