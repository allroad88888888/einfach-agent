import { afterEach, describe, expect, it } from 'vitest'
import { McpCommandError } from './errors'
import { trackedChildCount } from './exitNet'
import { fakeConnectArgs, processExists, waitFor } from './fakeMcpServer.testHarness'
import { createMcpRoutes } from './index'
import type { NodeHostRouteTable } from '../routeTable'

// ═══ 本文件盯的是「子进程不会活过它该活的时候」 ═══
// 一个没被杀干净的 MCP server 会一直挂在用户机器上，而症状（几天后一堆僵尸进程）离病因极远。
// 四条路径各一个用例：正常注销 / 宿主进程退出 / 子进程自己崩 / 关不掉时强杀。

let dispose: (() => Promise<void>) | undefined

function routes(): NodeHostRouteTable {
  let captured: (() => Promise<void>) | undefined
  const table = createMcpRoutes({ registerHostDisposer: (fn) => { captured = fn } })
  dispose = captured
  return table
}

afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const args = (payload: Record<string, unknown>): Record<string, unknown> => ({ input: payload })

async function connect(
  table: NodeHostRouteTable,
  serverId: string,
  mode: string,
): Promise<number> {
  const connected = await table.mcp_connect?.(fakeConnectArgs({ serverId, mode })) as Record<string, unknown>
  return connected.pid as number
}

describe('进程清理', () => {
  it('① 正常注销：进程收尸、退出码回传、退出兜底名单摘干净', async () => {
    const table = routes()
    const pid = await connect(table, 'clean', 'functional')
    expect(processExists(pid)).toBe(true)
    expect(trackedChildCount()).toBe(1)

    const result = await table.mcp_disconnect?.(args({
      serverId: 'clean',
      sessionToken: 'clean-session',
      gracePeriodMs: 2_000,
    })) as Record<string, unknown>
    expect(result).toMatchObject({ exitCode: 0, forcedKill: false })
    await waitFor(() => !processExists(pid), `进程 ${pid} 应已退出`)
    // 留在名单里就等于往一个已死（且可能被复用）的 pid 上发信号。
    expect(trackedChildCount()).toBe(0)
  })

  it('② 宿主进程退出：注册在 process 上的兜底真的把整组杀掉', async () => {
    // 这条只能测「那个 listener 装上了、而且它管用」。「Node 在正常退出时会跑 'exit' 回调」
    // 是 Node 自己的保证，已另行用探针实测过；这里直接把装上去的那个回调揪出来执行。
    // **实测结论也记在 exitNet.ts 里：SIGTERM / SIGINT 不走这条路**，信号归宿主装配层。
    const before = new Set(process.listeners('exit'))
    const table = routes()
    const pid = await connect(table, 'exit-net', 'stubborn')

    const installed = process.listeners('exit').filter((listener) => !before.has(listener))
    expect(installed, '会话建立后应装上退出兜底').toHaveLength(1)

    ;(installed[0] as () => void)()
    await waitFor(() => !processExists(pid), `退出兜底应杀掉进程 ${pid}`)
  })

  it('③ 子进程自己崩：会话自动从兜底名单里摘掉，不留悬挂条目', async () => {
    const table = routes()
    const pid = await connect(table, 'self-exit', 'exiting')
    await waitFor(() => !processExists(pid), `进程 ${pid} 应自行退出`)
    await waitFor(() => trackedChildCount() === 0, '崩掉的会话应自动摘出兜底名单')
  })

  it('④ 赖着不走的 server：grace 用尽后整组强杀', async () => {
    // stubborn 模式无视 stdin EOF。关 stdin 是「请你退出」的规范信号，它不听，就只剩强杀。
    const table = routes()
    const pid = await connect(table, 'stubborn', 'stubborn')

    const result = await table.mcp_disconnect?.(args({
      serverId: 'stubborn',
      sessionToken: 'stubborn-session',
      gracePeriodMs: 100,
    })) as Record<string, unknown>
    expect(result.forcedKill).toBe(true)
    // 被信号杀死时 `exitCode` 整键消失（Rust 的 `Option<i32>` + skip_serializing_if）。
    expect(Object.prototype.hasOwnProperty.call(result, 'exitCode')).toBe(false)
    await waitFor(() => !processExists(pid), `强杀后进程 ${pid} 应已消失`)
    expect(trackedChildCount()).toBe(0)
  })

  it('⑤ 装配层的 dispose 一次关掉全部会话', async () => {
    const table = routes()
    const first = await connect(table, 'bulk-a', 'functional')
    const second = await connect(table, 'bulk-b', 'stubborn')
    expect(trackedChildCount()).toBe(2)

    await dispose?.()
    dispose = undefined
    await waitFor(() => !processExists(first) && !processExists(second), '两个进程都该没了')
    expect(trackedChildCount()).toBe(0)
  })

  it('请求超时报 timeout，而且会话之后仍然关得掉', async () => {
    // 超时最怕的不是慢，是它把会话搞成一个既不响应也关不掉的状态。
    const table = routes()
    const pid = await connect(table, 'slow', 'timeout')
    const error = await table.mcp_call_tool?.(args({
      serverId: 'slow',
      sessionToken: 'slow-session',
      name: 'never-returns',
      timeoutMs: 60,
    })).then(() => expect.fail('本该超时'), (value: unknown) => value as McpCommandError)
    expect(error?.kind).toBe('timeout')
    expect(error?.message).toBe('MCP request `tools/call` timed out after 60 ms')

    const result = await table.mcp_disconnect?.(args({
      serverId: 'slow',
      sessionToken: 'slow-session',
      gracePeriodMs: 2_000,
    })) as Record<string, unknown>
    expect(result.forcedKill).toBe(false)
    await waitFor(() => !processExists(pid), `进程 ${pid} 应已退出`)
  })
})
