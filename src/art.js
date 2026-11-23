// 图片二创：拿卡片里的那张图当参考图，让图像工具再画几版。
//
// 带参考图改图（edit_image 的 source_path）在宿主里要求"会话工作区"：路径必须落在
// agent.session.header.cwd 里面。工作台是独立服务、没有聊天会话，所以这里给工具一个
// 只带 cwd 的替身 agent，把插件自己的数据目录当作工作区——参考图本来就在
// <dshHome>/mydesk/files，工具写回的成品也落在 <dshHome>/mydesk 下，两边都不出圈。
//
// 拿不到可改图的工具时退化成"按提示词重画"，界面上会说明这次没有用原图当参考。
import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { imageBuffer } from './images.js'
import { generateToolImage } from './image-tool.js'
import { tr } from './i18n.js'
import { newId } from './ops.js'
import { dshHome } from './store.js'

const MAX_BYTES = 40_000_000
const MAX_VARIANTS = 24
const RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9']
const EDIT_NAMES = ['edit_image']
// 文生图：优先用带 aspect_ratio 的 generate_image，其次是订阅工具与兼容别名
const DRAW_NAMES = ['generate_image', 'dsh_subscriptions_image_generate', 'image_generate']
// 接口只收 size 时，把画幅折成最接近的像素尺寸
const SIZE_OF = { '1:1': '1024x1024', '4:3': '1536x1024', '3:4': '1024x1536', '16:9': '1536x1024', '9:16': '1024x1536' }
const GALLERY_MAX = 120

/** 插件数据目录；同一个目录在图像工具眼里就是"会话工作区"。 */
export function artRoot() {
  return join(dshHome(), 'mydesk')
}

function artAgent() {
  const cwd = artRoot()
  return {
    id: 'mydesk-art',
    session: {
      header: { cwd },
      append: () => ({ seq: 0 }),
      deriveMessages: () => [],
    },
  }
}

/**
 * 找可以直接调用的图像工具：改图优先，重画兜底。
 * 与 image-tool 一样只看公共注册/执行接口，并要求默认执行器声明可以直接调用。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{tools: object, edit: object|null, draw: object|null}|null}
 */
export function artTool(ctx) {
  const tools = ctx.get('tools')
  if (typeof tools?.executable !== 'function' || typeof tools?.execute !== 'function' || typeof tools?.selectExecutor !== 'function') return null
  let executor
  try {
    executor = tools.selectExecutor()
  } catch {
    return null
  }
  if (typeof executor?.describe !== 'function') return null
  const direct = (name) => {
    try {
      const definition = tools.executable(name)
      if (definition?.parameters?.properties?.prompt?.type !== 'string') return null
      if (!executor.describe([definition])?.schemas?.some(schema => schema.name === name)) return null
      return { name, definition }
    } catch {
      return null
    }
  }
  const edit = EDIT_NAMES.map(direct).find(Boolean) ?? null
  const draw = DRAW_NAMES.map(direct).find(Boolean) ?? null
  return edit || draw ? { tools, edit, draw } : null
}

/** 界面用的能力说明：能不能拿原图改，还是只能按提示词重画。 */
export function artState(ctx) {
  const tool = artTool(ctx)
  return { ready: Boolean(tool), edit: Boolean(tool?.edit), redraw: Boolean(tool?.draw) }
}

/** 有界读取：只认插件数据目录里的普通图片。 */
async function readImageFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(tr('图像工具返回的图片路径无效'))
  const root = await realpath(artRoot())
  const file = await realpath(path)
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error(tr('图像工具返回的图片路径无效'))
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error(tr('图片太大'))
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error(tr('图像工具返回的图片路径无效'))
    return imageBuffer(buffer.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

function dataUrlBuffer(text) {
  if (typeof text !== 'string') return null
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(text)
  if (!match) return null
  try {
    return imageBuffer(Buffer.from(match[2], 'base64'))
  } catch {
    return null
  }
}

/** 一次工具调用的结果：成功给出 value，失败给出人能看懂的理由。 */
async function runTool(tool, args, signal) {
  const id = `mydesk:${randomUUID()}`
  const batch = await tool.tools.execute({
    calls: [{ type: 'tool-call', id, name: tool.name, arguments: JSON.stringify(args) }],
    agent: artAgent(),
    signal,
  })
  signal.throwIfAborted()
  const result = batch.results?.find(entry => entry.callId === id)?.result
  if (result?.isError) {
    if (result.error?.info?.code === 'UNKNOWN_TOOL') throw new Error(tr('当前工具执行器不支持直接调用图像工具，请改用原生工具执行器'))
    throw new Error(tr('图像工具失败：{reason}', { reason: String(result.error?.message ?? '').slice(0, 500) }))
  }
  if (result?.isError !== false || !result?.value) throw new Error(tr('图像工具没有返回结果'))
  return result.value
}

async function editWithReference(tool, { prompt, sourcePath, ratio, signal }) {
  const value = await runTool(tool, {
    prompt,
    source_path: sourcePath,
    ...(ratio ? { aspect_ratio: ratio } : {}),
  }, signal)
  const saved = typeof value.savedTo === 'string' && value.savedTo ? value.savedTo : null
  const image = saved ? await readImageFile(saved) : dataUrlBuffer(value.output)
  if (!image) throw new Error(value.saveError ? tr('图像工具没能保存成品：{reason}', { reason: String(value.saveError).slice(0, 300) }) : tr('图像工具没有返回图片'))
  return { image, mode: 'edit', provider: value.provider, model: value.model }
}

/** 按目标工具自己声明的参数拼参数：有的收 aspect_ratio，有的只收 size。 */
function drawArgs(tool, { prompt, ratio }) {
  const props = tool?.definition?.parameters?.properties ?? {}
  const args = { prompt }
  if (ratio && props.aspect_ratio) args.aspect_ratio = ratio
  else if (props.size) {
    const size = SIZE_OF[ratio] ?? '1024x1024'
    if (Array.isArray(props.size.enum) && !props.size.enum.includes(size)) {
      if (props.size.enum.includes('auto')) args.size = 'auto'
    } else {
      args.size = size
    }
  }
  return args
}

async function drawFromPrompt(tool, { prompt, ratio, signal }) {
  if (tool?.draw) {
    // runTool 只往外发 tools.execute，所以这里把注册表一起带上
    const value = await runTool({ ...tool.draw, tools: tool.tools }, drawArgs(tool.draw, { prompt, ratio }), signal)
    const path = Array.isArray(value.paths) && value.paths.length ? value.paths[0] : typeof value.savedTo === 'string' ? value.savedTo : null
    const saved = path ? await readImageFile(path).catch(() => null) : null
    const image = saved ?? dataUrlBuffer(value.output)
    if (image) return { image, mode: 'draw', provider: value.provider, model: value.model }
  }
  if (!tool?.draw) throw new Error(tr('没有可用的文生图工具；先在设置里接入生图模型'))
  // 兜底：复用插件原有的生图读取路径（它会去订阅生图目录里取成品）。
  const host = { get: key => (key === 'tools' ? tool.tools : undefined) }
  const image = await generateToolImage(host, {}, prompt, { signal })
  return { image, mode: 'draw' }
}

/** 卡片里的图 → 插件数据目录里的真实文件。 */
async function sourcePathOf(src) {
  const prefix = 'mydesk/files/'
  if (typeof src !== 'string' || !src.startsWith(prefix)) return null
  const name = src.slice(prefix.length)
  if (!/^[\w.-]+$/.test(name)) return null
  const file = join(artRoot(), 'files', name)
  try {
    await realpath(file)
    return file
  } catch {
    return null
  }
}

/** 选参考图：显式指定 > 卡片自己的图 > 最近一版二创。 */
function pickSource(item, wanted) {
  const variants = Array.isArray(item.art?.variants) ? item.art.variants : []
  if (wanted) {
    const hit = variants.find(row => row.id === wanted)
    if (hit?.src) return hit.src
  }
  if (item.media?.src && item.kind !== 'video') return item.media.src
  return variants.length ? variants[variants.length - 1].src : null
}

async function saveIntoFiles(image) {
  const dir = join(artRoot(), 'files')
  await mkdir(dir, { recursive: true })
  const name = `${newId('a')}${image.ext}`
  await writeFile(join(dir, name), image.buffer)
  return `mydesk/files/${name}`
}

function variantOf(item) {
  const art = item.art && typeof item.art === 'object' ? item.art : {}
  return { ...art, variants: Array.isArray(art.variants) ? art.variants : [] }
}

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

/**
 * 二创一张图：改图或重画，然后把新的一版挂到卡片上。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} store - 状态仓库。
 * @param {{id: string, prompt?: string, ratio?: string, source?: string}} body - 请求体。
 * @returns {Promise<{state: object, variant?: object, art: object}>}
 */
export async function remixArt(ctx, store, body) {
  const state = await store.read()
  const item = state.items.find(row => row.id === body.id)
  if (!item) throw badRequest(tr('找不到这条灵感'), 404)
  if (item.kind !== 'image') throw badRequest(tr('只有图片卡片可以二创'))
  const prompt = String(body.prompt ?? '').trim().slice(0, 2000)
  if (!prompt) throw badRequest(tr('先写一句想怎么改'))
  const tool = artTool(ctx)
  if (!tool) throw badRequest(tr('没有可用的图像工具；先在设置里接入生图模型'))
  const ratio = RATIOS.includes(body.ratio) ? body.ratio : undefined
  const signal = AbortSignal.timeout(300_000)
  const source = pickSource(item, body.source)
  const sourcePath = source ? await sourcePathOf(source) : null
  let drawn
  if (tool.edit && sourcePath) {
    try {
      drawn = await editWithReference({ ...tool.edit, tools: tool.tools }, { prompt, sourcePath, ratio, signal })
    } catch (error) {
      // 改图失败就退一步按提示词重画，别让用户面对一句干巴巴的工具报错。
      if (!tool.draw) throw error
      drawn = await drawFromPrompt(tool, { prompt, signal })
    }
  } else {
    drawn = await drawFromPrompt(tool, { prompt, signal })
  }
  signal.throwIfAborted()
  const src = await saveIntoFiles(drawn.image)
  const variant = {
    id: newId('v'),
    src,
    prompt,
    mode: drawn.mode,
    createdAt: new Date().toISOString(),
    ...(ratio ? { ratio } : {}),
    ...(drawn.provider ? { provider: drawn.provider } : {}),
    ...(drawn.model ? { model: drawn.model } : {}),
  }
  const next = await store.mutate(tr('二创一张图'), (draft) => {
    const row = draft.items.find(entry => entry.id === body.id)
    if (!row) throw badRequest(tr('找不到这条灵感'), 404)
    const art = variantOf(row)
    row.art = { ...art, prompt, updatedAt: variant.createdAt, variants: [...art.variants, variant].slice(-MAX_VARIANTS) }
    return draft
  })
  return { state: next, variant, art: artState(ctx) }
}

/**
 * 图库：按一句话连画几张，全部收进 `item.art.variants`。
 * 有参考图（选中的那张 / 封面 / 上一版）就接着它改，没有就让文生图工具从零画。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} store - 状态仓库。
 * @param {{id: string, prompt?: string, ratio?: string, count?: number, source?: string}} body - 请求体。
 * @returns {Promise<{state: object, added: object[], art: object}>}
 */
export async function galleryMake(ctx, store, body) {
  const state = await store.read()
  const item = state.items.find(row => row.id === body.id)
  if (!item) throw badRequest(tr('找不到这个图库'), 404)
  if (item.kind !== 'gallery') throw badRequest(tr('只有图库可以这样连画几张'))
  const prompt = String(body.prompt ?? '').trim().slice(0, 2000)
  if (!prompt) throw badRequest(tr('先写一句想要什么画面'))
  const tool = artTool(ctx)
  if (!tool) throw badRequest(tr('没有可用的图像工具；先在设置里接入生图模型'))
  const ratio = RATIOS.includes(body.ratio) ? body.ratio : undefined
  const count = Math.min(Math.max(Math.round(Number(body.count) || 1), 1), 4)
  const signal = AbortSignal.timeout(300_000 * count)
  const source = pickSource(item, body.source)
  const sourcePath = source ? await sourcePathOf(source) : null
  const added = []
  let failure = null
  for (let index = 0; index < count; index += 1) {
    signal.throwIfAborted()
    try {
      const drawn = tool.edit && sourcePath
        ? await editWithReference({ ...tool.edit, tools: tool.tools }, { prompt, sourcePath, ratio, signal })
        : await drawFromPrompt(tool, { prompt, ratio, signal })
      const createdAt = new Date().toISOString()
      added.push({
        id: newId('v'),
        src: await saveIntoFiles(drawn.image),
        prompt,
        mode: drawn.mode,
        createdAt,
        ...(ratio ? { ratio } : {}),
        ...(drawn.provider ? { provider: drawn.provider } : {}),
        ...(drawn.model ? { model: drawn.model } : {}),
      })
    } catch (error) {
      signal.throwIfAborted()
      if (!failure) failure = error
    }
  }
  if (!added.length) throw failure ?? badRequest(tr('这次一张都没画出来'))
  const next = await store.mutate(tr('往图库里画了 {n} 张', { n: added.length }), (draft) => {
    const row = draft.items.find(entry => entry.id === body.id)
    if (!row) throw badRequest(tr('找不到这个图库'), 404)
    const art = variantOf(row)
    row.art = {
      ...art,
      prompt,
      updatedAt: added[added.length - 1].createdAt,
      variants: [...art.variants, ...added].slice(-GALLERY_MAX),
    }
    if (!row.media?.src) row.media = { src: added[0].src }
    return draft
  })
  return { state: next, added, art: artState(ctx) }
}

/**
 * 把某一版换成卡片的主图，或者删掉某一版。
 * @param {object} store - 状态仓库。
 * @param {{id: string, variantId?: string}} body - 请求体。
 * @param {'use'|'delete'} action - 要做的动作。
 * @returns {Promise<{state: object, art: object}>}
 */
export async function variantAction(store, body, action) {
  const variantId = String(body.variantId ?? '')
  const next = await store.mutate(action === 'use' ? tr('换这张做主图') : tr('删掉这一版'), (draft) => {
    const row = draft.items.find(entry => entry.id === body.id)
    if (!row) throw badRequest(tr('找不到这条灵感'), 404)
    const art = variantOf(row)
    const variant = art.variants.find(entry => entry.id === variantId)
    if (!variant) throw badRequest(tr('这一版已经不在了'), 404)
    if (action === 'use') {
      row.media = { ...(row.media ?? {}), src: variant.src }
      if (variant.ratio) {
        const [w, h] = variant.ratio.split(':').map(Number)
        if (w && h) row.media = { ...row.media, w, h }
      }
      return draft
    }
    row.art = { ...art, variants: art.variants.filter(entry => entry.id !== variantId) }
    return draft
  })
  return { state: next }
}

/**
 * 把本地拖进来 / 粘贴进来的图收进图库。
 * 文件先由 `/mydesk/upload` 落到 `files/`，这里只负责校验确实在插件目录里，再挂成一版。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} store - 状态仓库。
 * @param {{id: string, sources?: string[]}} body - 请求体：图库卡片 id 与已上传的 `mydesk/files/...` 列表。
 * @returns {Promise<{state: object, added: object[], art: object}>}
 */
export async function uploadArt(ctx, store, body) {
  const state = await store.read()
  const item = state.items.find(row => row.id === body.id)
  if (!item) throw badRequest(tr('找不到这个图库'), 404)
  if (item.kind !== 'gallery') throw badRequest(tr('只有图库可以这样收图'))
  const sources = Array.isArray(body.sources) ? body.sources.filter(src => typeof src === 'string') : []
  if (!sources.length) throw badRequest(tr('没有收到图片'))
  // 同一个 src 已经在图库里就不再收（拖两次同一张、或者先建了图再拖）。
  const existing = new Set(variantOf(item).variants.map(row => row.src))
  const wanted = [...new Set(sources)].filter(src => !existing.has(src))
  if (!wanted.length) throw badRequest(tr('这几张已经在图库里了'))
  const added = []
  const stamp = new Date().toISOString()
  for (const src of wanted) {
    if (added.length >= GALLERY_MAX) break
    const file = await sourcePathOf(src)
    if (!file) continue
    const image = await readImageFile(file).catch(() => null)
    if (!image) continue
    added.push({ id: newId('v'), src, prompt: '', mode: 'upload', createdAt: stamp })
  }
  if (!added.length) throw badRequest(tr('这几张图收不进来：只认插件自己目录里的图片'))
  const next = await store.mutate(tr('收了 {n} 张图', { n: added.length }), (draft) => {
    const row = draft.items.find(entry => entry.id === body.id)
    if (!row) throw badRequest(tr('找不到这个图库'), 404)
    const art = variantOf(row)
    row.art = { ...art, updatedAt: stamp, variants: [...art.variants, ...added].slice(-GALLERY_MAX) }
    if (!row.media?.src) row.media = { ...(row.media ?? {}), src: added[0].src }
    return draft
  })
  return { state: next, added, art: artState(ctx) }
}

const BOARD_MODES = ['grid', 'board']
const BOARD_MAX_ITEMS = 300

/** 铺开画布的布局：裁掉不认识的东西，坐标与宽高都夹到安全范围内。 */
export function normalizeBoard(raw) {
  const board = raw && typeof raw === 'object' ? raw : {}
  const items = {}
  const source = board.items && typeof board.items === 'object' ? board.items : {}
  let count = 0
  for (const [id, box] of Object.entries(source)) {
    if (count >= BOARD_MAX_ITEMS) break
    if (!box || typeof box !== 'object') continue
    const x = Math.round(Number(box.x))
    const y = Math.round(Number(box.y))
    const w = Math.round(Number(box.w))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) continue
    items[String(id).slice(0, 64)] = {
      x: Math.min(Math.max(x, -40000), 40000),
      y: Math.min(Math.max(y, -40000), 40000),
      w: Math.min(Math.max(w, 40), 4000),
      ...(typeof box.group === 'string' && box.group ? { group: box.group.slice(0, 40) } : {}),
    }
    count += 1
  }
  const pan = board.pan && typeof board.pan === 'object' ? board.pan : {}
  const zoom = Number(board.zoom)
  return {
    mode: BOARD_MODES.includes(board.mode) ? board.mode : 'grid',
    zoom: Number.isFinite(zoom) ? Math.min(Math.max(zoom, 0.2), 4) : 1,
    pan: { x: Math.round(Number(pan.x) || 0), y: Math.round(Number(pan.y) || 0) },
    items,
  }
}

/**
 * 存图库「铺开」模式的位置、缩放与组合。纯排版，不占撤销位。
 * @param {object} store - 状态仓库。
 * @param {{id: string, board?: object}} body - 请求体。
 * @returns {Promise<{state: object, board: object}>}
 */
export async function boardLayout(store, body) {
  const state = await store.read()
  const item = state.items.find(row => row.id === body.id)
  if (!item) throw badRequest(tr('找不到这个图库'), 404)
  if (item.kind !== 'gallery') throw badRequest(tr('只有图库有铺开画布'))
  const board = normalizeBoard(body.board)
  const next = await store.mutate(tr('调整图库布局'), (draft) => {
    const row = draft.items.find(entry => entry.id === body.id)
    if (!row) throw badRequest(tr('找不到这个图库'), 404)
    row.art = { ...variantOf(row), board }
    return draft
  }, { undoable: false })
  return { state: next, board }
}
