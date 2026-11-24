// 工具调用的两条通道：优先直接调工具体（工作台没有聊天会话，走不了 tools/pre-execute
// 里的 Auto 复核），只在执行器不公布工具体时退回批量接口。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callTool, pluginAgent } from '../src/tool-run.js'

const DEFINITION = { name: 'generate_image', parameters: { properties: { prompt: { type: 'string' } } } }

function direct(inner, { name = 'generate_image', batch } = {}) {
  return {
    executable: wanted => (wanted === name ? { ...DEFINITION, name, execute: inner } : undefined),
    execute: batch ?? (() => assert.fail('must not use the batch channel')),
  }
}

test('callTool 直接执行工具体，并给出形状正确的 exec', async () => {
  let seen
  const tools = direct(async (args, exec) => {
    seen = { args, exec }
    return { paths: ['/tmp/a.png'] }
  })
  const agent = pluginAgent('mydesk-art', '/data/mydesk')
  const signal = AbortSignal.timeout(5_000)
  const value = await callTool(tools, 'generate_image', { prompt: 'boat' }, { agent, signal })
  assert.deepEqual(value, { paths: ['/tmp/a.png'] })
  assert.deepEqual(seen.args, { prompt: 'boat' })
  assert.equal(seen.exec.name, 'generate_image')
  assert.equal(seen.exec.arguments, seen.args)
  assert.match(seen.exec.callId, /^mydesk:/)
  assert.equal(seen.exec.rootCallId, seen.exec.callId)
  assert.equal(seen.exec.agent, agent)
  assert.equal(seen.exec.agent.session.header.cwd, '/data/mydesk')
  assert.equal(seen.exec.signal, signal)
  assert.equal(typeof seen.exec.signal.throwIfAborted, 'function')
  assert.equal(typeof seen.exec.deferContext, 'function')
  assert.equal(typeof seen.exec.concludeTurn, 'function')
})

test('执行器只公布批量接口时退回批量通道', async () => {
  let batch
  const tools = {
    executable: name => ({ ...DEFINITION, name }),
    execute: input => {
      batch = input
      return { results: [{ callId: input.calls[0].id, result: { isError: false, value: { paths: ['/tmp/b.png'] } } }] }
    },
  }
  const value = await callTool(tools, 'generate_image', { prompt: 'boat', size: 'auto' })
  assert.deepEqual(value, { paths: ['/tmp/b.png'] })
  assert.equal(batch.calls[0].type, 'tool-call')
  assert.equal(batch.calls[0].name, 'generate_image')
  assert.deepEqual(JSON.parse(batch.calls[0].arguments), { prompt: 'boat', size: 'auto' })
  assert.equal(batch.agent, undefined)
})

test('兼容管线形状的返回，并在工具失败时抛出可识别的错误', async () => {
  const shapes = direct(async () => ({ isError: false, value: { paths: ['/tmp/c.png'] }, content: [] }))
  assert.deepEqual(await callTool(shapes, 'generate_image', {}), { paths: ['/tmp/c.png'] })

  const failed = direct(async () => ({ isError: true, error: { message: 'quota 429', info: { code: 'RATE_LIMIT' } } }))
  await assert.rejects(callTool(failed, 'generate_image', {}), error => {
    assert.equal(error.message, 'quota 429')
    assert.equal(error.fromTool, true)
    assert.equal(error.code, 'RATE_LIMIT')
    return true
  })

  // 工具自己抛的错原样上抛：调用方据此区分「工具失败」和「我们自己写错参数」。
  const boom = direct(async () => { throw new Error('executor missing') })
  await assert.rejects(callTool(boom, 'generate_image', {}), error => error.message === 'executor missing' && !error.fromTool)
})

test('没有这个工具时给出 UNKNOWN_TOOL，便于回退到别的生图来源', async () => {
  const tools = direct(async () => assert.fail('must not dispatch'), { name: 'other' })
  await assert.rejects(callTool(tools, 'generate_image', {}), error => {
    assert.equal(error.code, 'UNKNOWN_TOOL')
    assert.match(error.message, /generate_image/)
    return true
  })
  await assert.rejects(callTool({}, 'generate_image', {}), error => error.code === 'UNKNOWN_TOOL')
})
