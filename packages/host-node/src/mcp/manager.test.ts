import { afterEach, describe, expect, it } from 'vitest'
import { McpCommandError } from './errors'
import { fakeConnectArgs } from './fakeMcpServer.testHarness'
import { createMcpRoutes } from './index'
import type { NodeHostRouteTable } from '../routeTable'

// 每个用例自己建一张路由表（= 一份独立的会话登记表），并在 afterEach 里 dispose——
// **测试绝不能漏掉子进程**：漏一个就是一个跟着 CI 机器活下去的 node 进程。
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

async function expectMcpError(promise: Promise<unknown>): Promise<McpCommandError> {
  try {
    await promise
    return expect.fail('本该失败的调用返回了成功')
  } catch (error) {
    expect(error).toBeInstanceOf(McpCommandError)
    return error as McpCommandError
  }
}

function inputArgs(payload: Record<string, unknown>): Record<string, unknown> {
  return { input: payload }
}

describe('mcp 域：连接、列举、调用、注销', () => {
  it('走完一整趟：握手 → 翻页 → 调用 → 注销', async () => {
    const table = routes()
    const connected = await table.mcp_connect?.(fakeConnectArgs({ serverId: 'ok', mode: 'functional' })) as Record<string, unknown>

    expect(connected.serverId).toBe('ok')
    expect(connected.sessionToken).toBe('ok-session')
    expect(connected.protocolVersion).toBe('2025-11-25')
    expect(connected.instructions).toBe('test server')
    expect(connected.capabilities).toEqual({ tools: { listChanged: true } })
    expect(typeof connected.pid).toBe('number')
    // serverInfo 的 `title: null` 在 Rust 侧经 `Option` 反序列化再序列化后**键消失**。
    expect(connected.serverInfo).toEqual({ name: 'fake-server', version: '1.0.0' })

    const listed = await table.mcp_list_tools?.(inputArgs({
      serverId: 'ok',
      sessionToken: 'ok-session',
      allPages: true,
      timeoutMs: 5_000,
    })) as Record<string, unknown>
    expect(listed.pagesFetched).toBe(2)
    expect(listed.truncated).toBe(false)
    expect(listed.nextCursor).toBeUndefined()
    expect((listed.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['first', 'second'])
    // 第二页那条工具带 `description: null`，同样该整键消失。
    expect(listed.tools).toEqual([
      { name: 'first', description: '第一页', inputSchema: { type: 'object' } },
      { name: 'second', inputSchema: { type: 'object' } },
    ])

    const called = await table.mcp_call_tool?.(inputArgs({
      serverId: 'ok',
      sessionToken: 'ok-session',
      name: 'first',
      arguments: { value: 42 },
      meta: { traceId: 'test' },
    })) as Record<string, unknown>
    expect(called).toEqual({
      serverId: 'ok',
      toolName: 'first',
      content: [{ type: 'text', text: 'called' }],
      structuredContent: { ok: true },
      isError: false,
    })

    const disconnected = await table.mcp_disconnect?.(inputArgs({
      serverId: 'ok',
      sessionToken: 'ok-session',
      gracePeriodMs: 2_000,
    })) as Record<string, unknown>
    expect(disconnected).toEqual({
      serverId: 'ok',
      sessionToken: 'ok-session',
      exitCode: 0,
      forcedKill: false,
    })
  })

  it('对端把响应劈成逐字节的 chunk（半包 + UTF-8 跨 chunk）照样解得出来', async () => {
    // 这条是端到端的：假 server 把整条响应一个字节一个字节写出去，`第一页` 的每个汉字都会被
    // 管道边界切开。分帧按字节走、整行才解码，所以字符不会坏。
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'split', mode: 'split' }))
    const listed = await table.mcp_list_tools?.(inputArgs({
      serverId: 'split',
      sessionToken: 'split-session',
      allPages: true,
    })) as Record<string, unknown>
    expect((listed.tools as { description?: string }[])[0]?.description).toBe('第一页')
  })

  it('对端把三条消息挤进一次 write（粘包）时一条都不丢', async () => {
    // packed 模式在同一个 write 里塞了 通知 + 服务端 ping 请求 + initialize 响应。
    // 分帧若按「一个 chunk 一条消息」写，这里会整个失败。
    const table = routes()
    const connected = await table.mcp_connect?.(
      fakeConnectArgs({ serverId: 'packed', mode: 'packed' }),
    ) as Record<string, unknown>
    expect(connected.protocolVersion).toBe('2025-11-25')
  })

  it('畸形行只丢它自己，后面的消息照常', async () => {
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'junk', mode: 'malformed-line' }))
    const called = await table.mcp_call_tool?.(inputArgs({
      serverId: 'junk',
      sessionToken: 'junk-session',
      name: 'anything',
    })) as Record<string, unknown>
    expect(called.content).toEqual([{ type: 'text', text: 'survived' }])
  })

  it('对端返回 JSON-RPC error 时带上 code 与 data', async () => {
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'rpc', mode: 'rpc-error' }))
    const error = await expectMcpError(table.mcp_call_tool?.(inputArgs({
      serverId: 'rpc',
      sessionToken: 'rpc-session',
      name: 'boom',
    })) ?? Promise.resolve())
    expect(error.kind).toBe('rpc_error')
    expect(error.rpcCode).toBe(-32000)
    expect(error.data).toEqual({ detail: 'x' })
    expect(error.message).toBe('MCP request `tools/call` failed: tool exploded (-32000)')
    // 跨 HTTP 之后 kind 必须还在——失败分类器只认它。
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ kind: 'rpc_error', serverId: 'rpc' })
  })
})

describe('mcp 域：协议校验', () => {
  it('请求一个不受支持的协议版本，在 spawn 之前就失败', async () => {
    const table = routes()
    const args = fakeConnectArgs({ serverId: 'bad-version', mode: 'functional' });
    (args.input as Record<string, unknown>).protocolVersion = '2025-06-18'
    const error = await expectMcpError(table.mcp_connect?.(args) ?? Promise.resolve())
    expect(error.kind).toBe('invalid_input')
    expect(error.message).toContain('supports only')
  })

  it('对端选了不受支持的版本 → protocol_error', async () => {
    const table = routes()
    const error = await expectMcpError(
      table.mcp_connect?.(fakeConnectArgs({ serverId: 'future', mode: 'unsupported' })) ?? Promise.resolve(),
    )
    expect(error.kind).toBe('protocol_error')
    expect(error.serverId).toBe('future')
    expect(error.message).toContain('2099-01-01')
    expect(error.message).toContain('2025-11-25')
  })

  it('不声明 tools capability 的服务被拒', async () => {
    const table = routes()
    const error = await expectMcpError(
      table.mcp_connect?.(fakeConnectArgs({ serverId: 'res', mode: 'resources-only' })) ?? Promise.resolve(),
    )
    expect(error.kind).toBe('protocol_error')
    expect(error.message).toContain('tools capability')
  })

  it('serverInfo 名字为空白 → protocol_error', async () => {
    const table = routes()
    const error = await expectMcpError(
      table.mcp_connect?.(fakeConnectArgs({ serverId: 'anon', mode: 'no-server-info-name' })) ?? Promise.resolve(),
    )
    expect(error.kind).toBe('protocol_error')
    expect(error.message).toContain('serverInfo.name')
  })

  it('OS 起不来的命令报独立的 command_spawn_failed', async () => {
    // 这个 kind 是失败分类器判「永久失败」的唯一依据，不能与可重试的 spawn_failed 混。
    const table = routes()
    const error = await expectMcpError(table.mcp_connect?.(inputArgs({
      serverId: 'missing',
      sessionToken: 'missing-session',
      command: 'web-agent-mcp-binary-that-does-not-exist',
    })) ?? Promise.resolve())
    expect(error.kind).toBe('command_spawn_failed')
    expect(error.serverId).toBe('missing')
  })

  it('command 里带 NUL 时也报 command_spawn_failed，而不是裸 TypeError', async () => {
    // Node 对 NUL 是**同步抛 TypeError**，Rust 是 `Err(InvalidInput)` → command_spawn_failed。
    // 不接住的话，一份永远起不来的配置会因为「错误没有 kind」被判成暂时失败、无限重连。
    const table = routes()
    const error = await expectMcpError(table.mcp_connect?.(inputArgs({
      serverId: 'nul',
      sessionToken: 'nul-session',
      command: 'node\u0000evil',
    })) ?? Promise.resolve())
    expect(error.kind).toBe('command_spawn_failed')
    expect(error.serverId).toBe('nul')
  })

  it('累计工具数超上限时拒绝整份清单', async () => {
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'many', mode: 'tool-limit' }))
    const capped = await table.mcp_list_tools?.(inputArgs({
      serverId: 'many',
      sessionToken: 'many-session',
      allPages: false,
      timeoutMs: 10_000,
    })) as Record<string, unknown>
    expect((capped.tools as unknown[]).length).toBe(1_000)
    expect(capped.truncated).toBe(true)

    const error = await expectMcpError(table.mcp_list_tools?.(inputArgs({
      serverId: 'many',
      sessionToken: 'many-session',
      allPages: true,
      timeoutMs: 10_000,
    })) ?? Promise.resolve())
    expect(error.kind).toBe('protocol_error')
    expect(error.message).toContain('1000-tool safety limit')
    expect(error.message).toContain('1001')
  })

  it('游标原地打转 → protocol_error，而不是转到超时', async () => {
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'loop', mode: 'repeat-cursor' }))
    const error = await expectMcpError(table.mcp_list_tools?.(inputArgs({
      serverId: 'loop',
      sessionToken: 'loop-session',
      allPages: true,
      timeoutMs: 5_000,
    })) ?? Promise.resolve())
    expect(error.kind).toBe('protocol_error')
    expect(error.message).toContain('repeated cursor `same`')
  })

  it('maxPages 为 0 报错、超上限钳住', async () => {
    const table = routes()
    await table.mcp_connect?.(fakeConnectArgs({ serverId: 'pages', mode: 'functional' }))
    const error = await expectMcpError(table.mcp_list_tools?.(inputArgs({
      serverId: 'pages',
      sessionToken: 'pages-session',
      maxPages: 0,
    })) ?? Promise.resolve())
    expect(error.kind).toBe('invalid_input')
    expect(error.message).toBe('maxPages must be greater than zero')

    const listed = await table.mcp_list_tools?.(inputArgs({
      serverId: 'pages',
      sessionToken: 'pages-session',
      maxPages: 1,
      allPages: true,
    })) as Record<string, unknown>
    expect(listed.truncated).toBe(true)
    expect(listed.nextCursor).toBe('next')
    expect(listed.pagesFetched).toBe(1)
  })
})
