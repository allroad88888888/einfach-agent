import { afterEach, describe, expect, it } from 'vitest'
import { McpCommandError } from './errors'
import { fakeConnectArgs, waitFor } from './fakeMcpServer.testHarness'
import { createMcpRoutes } from './index'
import type { McpHostEvent } from './lifecycle'
import type { NodeHostRouteTable } from '../routeTable'

let dispose: (() => Promise<void>) | undefined

function routes(events: McpHostEvent[]): NodeHostRouteTable {
  let captured: (() => Promise<void>) | undefined
  const table = createMcpRoutes({
    emitHostEvent: (event) => events.push(event),
    registerHostDisposer: (fn) => { captured = fn },
  })
  dispose = captured
  return table
}

afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

async function expectMcpError(promise: Promise<unknown> | undefined): Promise<McpCommandError> {
  try {
    await (promise ?? Promise.resolve())
    return expect.fail('本该失败的调用返回了成功')
  } catch (error) {
    expect(error).toBeInstanceOf(McpCommandError)
    return error as McpCommandError
  }
}

const args = (payload: Record<string, unknown>): Record<string, unknown> => ({ input: payload })

describe('生命周期事件', () => {
  it('tools/list_changed 通知带着 serverId 与 sessionToken 送出去', async () => {
    // 两个字段都必须在：C4 的 connector 靠它们过滤，少一个就会把上一代会话的迟到通知
    // 当成当前会话的，触发一次莫名其妙的工具对账。
    const events: McpHostEvent[] = []
    const table = routes(events)
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'changed', mode: 'list-changed' }))
    await waitFor(
      () => events.some((event) => event.name === 'mcp-stdio-tools-changed'),
      'tools-changed 事件',
    )
    expect(events[0]).toEqual({
      name: 'mcp-stdio-tools-changed',
      payload: { serverId: 'changed', sessionToken: 'changed-session' },
    })
  })

  it('子进程自己崩掉时主动发一次 close 事件，且只发一次', async () => {
    // 这是四条清理路径里最容易漏的一条：没人会来调 disconnect，而在途请求正等一个不会到的答案。
    const events: McpHostEvent[] = []
    const table = routes(events)
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'crash', mode: 'exiting' }))

    await waitFor(
      () => events.some((event) => event.name === 'mcp-stdio-close'),
      'close 事件',
    )
    // stdout EOF 与进程退出必然都会发生；去重不生效的话这里会是 2。
    await new Promise((resolve) => setTimeout(resolve, 150))
    const closeEvents = events.filter((event) => event.name === 'mcp-stdio-close')
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0]?.payload).toMatchObject({
      serverId: 'crash',
      sessionToken: 'crash-session',
    })

    // 崩掉之后再发请求：报「进程已退出」，不是挂到超时。
    const error = await expectMcpError(table.mcp_list_tools?.(args({
      serverId: 'crash',
      sessionToken: 'crash-session',
    })))
    expect(['process_exited', 'transport_closed']).toContain(error.kind)

    // 崩掉的会话仍然可以正常注销（收尸 + 从登记表里摘掉）。
    const disconnected = await table.mcp_disconnect?.(args({
      serverId: 'crash',
      sessionToken: 'crash-session',
    })) as Record<string, unknown>
    expect(disconnected.exitCode).toBe(7)
    expect(disconnected.forcedKill).toBe(false)
  })

  it('主动注销时不发意外关闭事件', async () => {
    // disconnect 会依次触发「stdin 关 → 进程退 → stdout EOF」，每一步都长得像掉线。
    // 不闭嘴的话，用户点一次「注销」会收到一条「连接意外断开」的告警。
    const events: McpHostEvent[] = []
    const table = routes(events)
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'quiet', mode: 'functional' }))
    await table.mcp_disconnect?.(args({ serverId: 'quiet', sessionToken: 'quiet-session' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(events.filter((event) => event.name === 'mcp-stdio-close')).toEqual([])
  })
})

describe('会话世代与登记表', () => {
  it('旧令牌既看不到也动不了当前会话', async () => {
    const table = routes([])
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'gen', mode: 'functional' }))

    for (const call of [
      () => table.mcp_list_tools?.(args({ serverId: 'gen', sessionToken: 'old' })),
      () => table.mcp_call_tool?.(args({ serverId: 'gen', sessionToken: 'old', name: 'first' })),
      () => table.mcp_disconnect?.(args({ serverId: 'gen', sessionToken: 'old' })),
    ]) {
      const error = await expectMcpError(call())
      expect(error.kind).toBe('stale_session')
    }

    // 当前世代仍然好用——上面三次失败没有误伤它。
    const listed = await table.mcp_list_tools?.(args({
      serverId: 'gen',
      sessionToken: 'gen-session',
    })) as Record<string, unknown>
    expect((listed.tools as unknown[]).length).toBe(2)
  })

  it('用过的令牌永不复用', async () => {
    const table = routes([])
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'reuse', mode: 'functional' }))
    await table.mcp_disconnect?.(args({ serverId: 'reuse', sessionToken: 'reuse-session' }))

    const error = await expectMcpError(
      table.mcp_connect?.(fakeConnectArgs({ serverId: 'reuse', mode: 'functional' })),
    )
    expect(error.kind).toBe('stale_session')

    // 换一个新令牌就能连上——拒的是令牌复用，不是这个服务。
    const connected = await table.mcp_connect?.(fakeConnectArgs({
      serverId: 'reuse',
      mode: 'functional',
      sessionToken: 'reuse-session-2',
    })) as Record<string, unknown>
    expect(connected.sessionToken).toBe('reuse-session-2')
  })

  it('同一个服务连两次报 already_connected', async () => {
    const table = routes([])
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'dup', mode: 'functional' }))
    const error = await expectMcpError(table.mcp_connect?.(fakeConnectArgs({
      serverId: 'dup',
      mode: 'functional',
      sessionToken: 'dup-session-2',
    })))
    expect(error.kind).toBe('already_connected')
  })

  it('没连过的服务：列举报 not_connected，注销也报 not_connected', async () => {
    const table = routes([])
    const listError = await expectMcpError(
      table.mcp_list_tools?.(args({ serverId: 'ghost', sessionToken: 't' })),
    )
    expect(listError.kind).toBe('not_connected')
    const disconnectError = await expectMcpError(
      table.mcp_disconnect?.(args({ serverId: 'ghost', sessionToken: 't' })),
    )
    expect(disconnectError.kind).toBe('not_connected')
    expect(disconnectError.message).toContain('is not connected')
  })

  it('工具名与服务状态都不对时，先报工具名——与 Rust 的判定顺序一致', async () => {
    const table = routes([])
    const error = await expectMcpError(
      table.mcp_call_tool?.(args({ serverId: 'ghost', sessionToken: 't', name: '   ' })),
    )
    expect(error.kind).toBe('invalid_input')
    expect(error.message).toBe('name must not be empty')
  })
})
