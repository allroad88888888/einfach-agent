import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { dispatchProtocolValue, type DispatchContext } from './dispatch'
import { McpLifecycleNotifier, type McpHostEvent } from './lifecycle'
import { PendingRequests, type RpcReply } from './pending'
import { McpStdinWriter } from './writer'

function makeContext(): DispatchContext & {
  events: McpHostEvent[]
  written: () => unknown[]
  replies: Map<number, RpcReply>
} {
  const stdin = new PassThrough()
  const chunks: Buffer[] = []
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  const events: McpHostEvent[] = []
  const pending = new PendingRequests()
  const replies = new Map<number, RpcReply>()
  return {
    writer: new McpStdinWriter(stdin),
    pending,
    lifecycle: new McpLifecycleNotifier('srv', 'token-1', (event) => events.push(event), () => false),
    events,
    written: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    replies,
  }
}

/** 登记一条在途请求，把收到的答案记进 map。 */
function expectReply(context: ReturnType<typeof makeContext>, id: number): void {
  context.pending.register(id, (reply) => context.replies.set(id, reply))
}

describe('JSON-RPC 消息分发', () => {
  it('响应投递给等它的那条请求', () => {
    const context = makeContext()
    expectReply(context, 7)
    dispatchProtocolValue({ jsonrpc: '2.0', id: 7, result: { ok: true } }, context)
    expect(context.replies.get(7)).toEqual({ kind: 'result', value: { ok: true } })
  })

  it('error 响应带上 code 与 data', () => {
    const context = makeContext()
    expectReply(context, 3)
    dispatchProtocolValue(
      { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'boom', data: { x: 1 } } },
      context,
    )
    expect(context.replies.get(3)).toEqual({
      kind: 'error',
      failure: { code: -32000, message: 'boom', data: { x: 1 } },
    })
  })

  it('既没有 result 也没有 error 的响应算内部错误', () => {
    const context = makeContext()
    expectReply(context, 4)
    dispatchProtocolValue({ jsonrpc: '2.0', id: 4 }, context)
    expect(context.replies.get(4)).toMatchObject({
      kind: 'error',
      failure: { code: -32603, message: 'response contains neither result nor error' },
    })
  })

  it('`"error": null` 走 error 分支而不是被当成没有 error', () => {
    // 判的是键在不在，不是值真不真——写成 `if (message.error)` 会让这条落到 result 分支去。
    const context = makeContext()
    expectReply(context, 5)
    dispatchProtocolValue({ jsonrpc: '2.0', id: 5, error: null }, context)
    expect(context.replies.get(5)).toEqual({
      kind: 'error',
      failure: { code: -32603, message: 'unknown JSON-RPC error', data: undefined },
    })
  })

  it('迟到的响应（没人在等）被静默丢弃', () => {
    const context = makeContext()
    expect(() =>
      dispatchProtocolValue({ jsonrpc: '2.0', id: 99, result: {} }, context),
    ).not.toThrow()
    expect(context.replies.size).toBe(0)
  })

  it('字符串 id 的响应被忽略——请求 id 只可能是自增整数', () => {
    const context = makeContext()
    expectReply(context, 1)
    dispatchProtocolValue({ jsonrpc: '2.0', id: '1', result: {} }, context)
    expect(context.replies.size).toBe(0)
  })

  it('服务端的 ping 请求当场回一个空 result', async () => {
    const context = makeContext()
    dispatchProtocolValue({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' }, context)
    await new Promise((resolve) => setImmediate(resolve))
    expect(context.written()).toEqual([{ jsonrpc: '2.0', id: 'server-ping', result: {} }])
  })

  it('不支持的服务端请求回 -32601 而不是不理它', async () => {
    // 不理的话对端会挂在那条请求上直到自己超时，症状是「我们的调用全都很慢」。
    const context = makeContext()
    dispatchProtocolValue({ jsonrpc: '2.0', id: 2, method: 'sampling/createMessage' }, context)
    await new Promise((resolve) => setImmediate(resolve))
    expect(context.written()).toEqual([
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'client method `sampling/createMessage` is not supported' },
      },
    ])
  })

  it('tools/list_changed 通知发事件，且不消耗任何在途请求', () => {
    const context = makeContext()
    expectReply(context, 7)
    dispatchProtocolValue({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, context)
    expect(context.events).toEqual([
      { name: 'mcp-stdio-tools-changed', payload: { serverId: 'srv', sessionToken: 'token-1' } },
    ])
    expect(context.replies.size).toBe(0)

    dispatchProtocolValue({ jsonrpc: '2.0', id: 7, result: { ok: true } }, context)
    expect(context.replies.get(7)).toEqual({ kind: 'result', value: { ok: true } })
  })

  it('其它通知既不回应答也不发事件', async () => {
    const context = makeContext()
    dispatchProtocolValue({ jsonrpc: '2.0', method: 'notifications/message', params: {} }, context)
    await new Promise((resolve) => setImmediate(resolve))
    expect(context.events).toEqual([])
    expect(context.written()).toEqual([])
  })

  it('批消息（数组）逐条分发', () => {
    const context = makeContext()
    expectReply(context, 1)
    expectReply(context, 2)
    dispatchProtocolValue(
      [
        { jsonrpc: '2.0', id: 1, result: 'a' },
        { jsonrpc: '2.0', id: 2, result: 'b' },
      ],
      context,
    )
    expect(context.replies.get(1)).toEqual({ kind: 'result', value: 'a' })
    expect(context.replies.get(2)).toEqual({ kind: 'result', value: 'b' })
  })

  it('method 不是字符串时按响应处理（照搬 Rust 的 as_str 语义）', () => {
    const context = makeContext()
    expectReply(context, 6)
    dispatchProtocolValue({ jsonrpc: '2.0', method: 7, id: 6, result: 'ok' }, context)
    expect(context.replies.get(6)).toEqual({ kind: 'result', value: 'ok' })
  })

  it('正在主动关闭时通知器闭嘴', () => {
    const events: McpHostEvent[] = []
    const notifier = new McpLifecycleNotifier('srv', 't', (e) => events.push(e), () => true)
    notifier.toolsChanged()
    notifier.closed('gone')
    expect(events).toEqual([])
  })

  it('close 事件一个会话只发一次', () => {
    // stdout EOF 与进程退出必然都会发生，两条都放出去会让前端走两遍「意外关闭」清理。
    const events: McpHostEvent[] = []
    const notifier = new McpLifecycleNotifier('srv', 't', (e) => events.push(e), () => false)
    notifier.closed('stdout closed')
    notifier.closed('process exited')
    notifier.toolsChanged()
    expect(events).toEqual([
      { name: 'mcp-stdio-close', payload: { serverId: 'srv', sessionToken: 't', message: 'stdout closed' } },
    ])
  })
})
