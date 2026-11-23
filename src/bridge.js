// 内置的「桥接到 image-gen」：工作台自己把请求转给 dsh-image-gen 注册的 generate_image，
// 再把成品读回来——不再需要额外安装 @local/dsh-media-desk-image-bridge 这个中转插件。
//
// 转调靠的是宿主公共工具接口（ctx.get('tools')），不引用 image-gen 的内部模块，也不读凭证。
// 和 src/art.js 一样，这里给工具一个只带 cwd 的替身 agent：generate_image 会把成品写进
// exec.agent.session.header.cwd 下，而工作台是独立服务、没有聊天会话。把插件数据目录当作
// 会话工作区，参考图与成品就都落在 ~/.dsh/mydesk 里，不出圈。
import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { imageBuffer } from './images.js'
import { tr } from './i18n.js'
import { dshHome } from './store.js'

// 只认 dsh-image-gen 的文生图工具：桥接的意思就是"转给它"。
const INNER_NAMES = ['generate_image']
const MAX_BYTES = 40_000_000
const TIMEOUT_MS = 300_000

/** 插件数据目录；在图像工具眼里它就是"会话工作区"。 */
export function bridgeRoot() {
  return join(dshHome(), 'mydesk')
}

function bridgeAgent() {
  const cwd = bridgeRoot()
  return {
    id: 'mydesk-bridge',
    session: {
      header: { cwd },
      append: () => ({ seq: 0 }),
      deriveMessages: () => [],
    },
  }
}

/**
 * 找可以直接调用的 generate_image：只看公共注册/执行接口，并要求默认执行器声明能直接调。
 * @param {object} ctx - Cordis 上下文。
 * @returns {{tools: object, name: string, definition: object}|null}
 */
export function bridgeTool(ctx) {
  const tools = ctx.get('tools')
  if (typeof tools?.executable !== 'function' || typeof tools?.execute !== 'function' || typeof tools?.selectExecutor !== 'function') return null
  let executor
  try {
    executor = tools.selectExecutor()
  } catch {
    return null
  }
  if (typeof executor?.describe !== 'function') return null
  for (const name of INNER_NAMES) {
    try {
      const definition = tools.executable(name)
      if (definition?.parameters?.properties?.prompt?.type !== 'string') continue
      if (!executor.describe([definition])?.schemas?.some(schema => schema.name === name)) continue
      return { tools, name, definition }
    } catch {
      // 执行器卸载/不可用时不影响别的生图来源；调用前会重新检测。
    }
  }
  return null
}

/** 有界读取：只认插件数据目录里的普通图片。 */
async function readImageIn(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(tr('生图工具返回的图片路径无效'))
  await mkdir(bridgeRoot(), { recursive: true })
  const root = await realpath(bridgeRoot())
  const file = await realpath(path)
  const rel = relative(root, file)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error(tr('生图工具返回的图片路径无效'))
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
    if (offset !== info.size) throw new Error(tr('生图工具返回的图片路径无效'))
    return imageBuffer(buffer.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

function dataUrlImage(text) {
  if (typeof text !== 'string') return null
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(text)
  if (!match) return null
  try {
    return imageBuffer(Buffer.from(match[2], 'base64'))
  } catch {
    return null
  }
}

/** 按内层工具自己声明的枚举发尺寸/质量，声明里没有就不发。 */
function innerArgs(tool, image, prompt) {
  const props = tool?.definition?.parameters?.properties ?? {}
  const args = { prompt }
  const pick = (key, value) => {
    if (typeof value !== 'string' || value === '') return
    const allowed = props[key]?.enum
    if (Array.isArray(allowed) && !allowed.includes(value)) {
      if (allowed.includes('auto')) args[key] = 'auto'
      return
    }
    args[key] = value
  }
  pick('size', image?.toolSize)
  pick('quality', image?.toolQuality)
  return args
}

/**
 * 转给 generate_image 画一张，返回 { buffer, ext }。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} image - 生图设置（用 toolSize / toolQuality）。
 * @param {string} prompt - 画面描述。
 * @param {{signal?: AbortSignal}} [options]
 */
export async function bridgeGenerate(ctx, image, prompt, { signal } = {}) {
  try {
    const tool = bridgeTool(ctx)
    if (!tool) throw new Error(tr('没找到 image-gen 的生图工具（generate_image）；先在 DSH 里装好并启用 dsh-image-gen，再刷新工作台'))
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    combined.throwIfAborted()
    const id = `mydesk-bridge:${randomUUID()}`
    const batch = await tool.tools.execute({
      calls: [{ type: 'tool-call', id, name: tool.name, arguments: JSON.stringify(innerArgs(tool, image, prompt)) }],
      agent: bridgeAgent(),
      signal: combined,
    })
    combined.throwIfAborted()
    const result = batch.results?.find(entry => entry.callId === id)?.result
    if (result?.isError) {
      if (result.error?.info?.code === 'UNKNOWN_TOOL') throw new Error(tr('当前工具执行器不支持直接调用生图工具，请改用原生工具执行器'))
      throw new Error(tr('生图工具失败：{reason}', { reason: String(result.error?.message ?? '').slice(0, 500) }))
    }
    if (result?.isError !== false || !result?.value) throw new Error(tr('生图工具没有返回结果'))
    const value = result.value
    const saved = typeof value.savedTo === 'string' && value.savedTo ? await readImageIn(value.savedTo).catch(() => null) : null
    const drawn = saved ?? dataUrlImage(value.output)
    if (!drawn) {
      if (value.svg) throw new Error(tr('这一档只收位图，这次返回的是 SVG；请改用「DSH 生成工具」'))
      throw new Error(value.saveError ? tr('生图工具没能保存成品：{reason}', { reason: String(value.saveError).slice(0, 300) }) : tr('生图工具没有返回图片'))
    }
    return drawn
  } catch (error) {
    // 与 generateToolImage 一致：不叠加工作台的重试，账号切换由工具自己处理。
    const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error })
    failure.name = error instanceof Error ? error.name : 'Error'
    failure.permanent = true
    throw failure
  }
}
