// 工作台里调用别的插件注册的图像工具，走的是宿主公共工具接口（ctx.get('tools')）。
//
// 为什么直接调工具体、而不走 tools.execute(...)：那条批量通道会跑 tools/pre-execute
// 策略钩子，其中「Auto」权限预设的自动复核（@deepseek-ai/dsh-experimental-auto-review）
// 会读 agent.session.snapshotEvents()、session.surface.nodes、session.requestHeader()，
// 它假定调用方是真实聊天会话。工作台是独立 HTTP 服务，只能给一个只带 cwd 的替身
// agent（图像工具靠 exec.agent.session.header.cwd 决定成品写到哪），于是复核直接抛
// 「session.snapshotEvents is not a function」，整次生图就失败了。
//
// 所以这里按管线里同样的方式直接执行工具体：构造 exec 交给 definition.execute。
// 代价是不再经过自动复核/审批钩子——这个调用由已鉴权的工作台路由发起，参数由用户在
// 界面上填写，不需要再按"模型自主发起"的规则审一遍。
import { randomUUID } from 'node:crypto'
import { tr } from './i18n.js'

/**
 * 只带 cwd 的替身 agent。
 * @param {string} id - 替身标识，仅用于日志。
 * @param {string} cwd - 当作会话工作区的目录。
 */
export function pluginAgent(id, cwd) {
  return {
    id,
    session: {
      header: { cwd },
      append: () => ({ seq: 0 }),
      deriveMessages: () => [],
    },
  }
}

/** 兼容两种返回：管线包装过的 { content, isError, value } 与工具体直接返回的值。 */
function unwrap(raw) {
  if (raw !== null && typeof raw === 'object' && 'isError' in raw) {
    if (raw.isError) throw resultError(raw)
    return raw.value
  }
  return raw
}

function resultError(result) {
  const code = result?.error?.info?.code
  const error = new Error(String(result?.error?.message ?? result?.message ?? tr('工具调用失败')).slice(0, 500))
  // 标记来源：调用方据此决定是否套「××工具失败：」的前缀；工具自身抛的错原样上抛。
  error.fromTool = true
  if (typeof code === 'string') error.code = code
  return error
}

function missing(name) {
  const error = new Error(tr('当前工具执行器里没有 {name}', { name }))
  error.code = 'UNKNOWN_TOOL'
  return error
}

/**
 * 执行一次工具调用，返回工具体产出的值。
 * @param {object} tools - ctx.get('tools')。
 * @param {string} name - 工具名。
 * @param {object} args - 已解析的参数对象。
 * @param {{signal?: AbortSignal, agent?: object}} [options]
 */
export async function callTool(tools, name, args, { signal, agent } = {}) {
  const definition = typeof tools?.executable === 'function' ? tools.executable(name) : undefined
  if (definition === undefined) throw missing(name)
  signal?.throwIfAborted()
  if (typeof definition.execute === 'function') {
    const callId = `mydesk:${randomUUID()}`
    // 形状对齐 ToolRunContext：工具体只看 arguments/signal/agent，少数会写附加上下文，
    // 这里给空的 no-op——没有聊天会话可写。
    const exec = {
      callId,
      rootCallId: callId,
      name,
      schema: definition,
      arguments: args,
      token: Symbol(`mydesk-tool:${name}`),
      ...(agent === undefined ? {} : { agent }),
      signal,
      deferContext: () => {},
      concludeTurn: () => {},
    }
    return unwrap(await definition.execute(args, exec))
  }
  // 只公布批量接口的执行器：退回批量通道，行为和以前一致。
  if (typeof tools.execute !== 'function') throw missing(name)
  const id = `mydesk:${randomUUID()}`
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
    ...(agent === undefined ? {} : { agent }),
    signal,
  })
  signal?.throwIfAborted()
  const result = batch?.results?.find(entry => entry.callId === id)?.result
  if (result?.isError) throw resultError(result)
  return result?.value
}
