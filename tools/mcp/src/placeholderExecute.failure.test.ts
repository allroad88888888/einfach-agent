// 透明连接失败时的降级判据（蓝图第六节的那张表）：连接抛错、连接超时，以及「不挂死」的
// 四条硬保证。五步编排本身的判据在 placeholderExecute.test.ts。

import { describe, expect, it } from 'vitest'
import { authError, temporaryError } from './clientManager.reconnect.fixtures'
import { MCP_CONNECT_TIMEOUT_MS } from './connect-mcp-server/connect-mcp-server'
import { classifyMcpFailure } from './failureClassification'
import {
  SERVER_ID,
  TOOL_NAME,
  placeholderContext,
  setupPlaceholderExecute,
} from './placeholderExecute.fixtures'
import { MCP_TOOL_CALL_TIMEOUT_MS } from './toolAdapter'

describe('连接失败 → 结构化回执，run 继续', () => {
  it('暂时失败：MCP_CONNECT_FAILED 且可重试——retryable 严格等于分类器的 reconnecting', async () => {
    const error = temporaryError()
    const wired = setupPlaceholderExecute({
      connect: () => {
        throw error
      },
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(classifyMcpFailure(error).status).toBe('reconnecting')
    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_FAILED',
      retryable: true,
      details: { serverId: SERVER_ID, transport: 'stdio', status: 'reconnecting', viaPlaceholder: true },
    })
  })

  it('永久失败：同一个分类器说不可重试，占位就不可重试——不自己另写一套判断', async () => {
    const error = authError()
    const wired = setupPlaceholderExecute({
      connect: () => {
        throw error
      },
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(classifyMcpFailure(error).status).toBe('error')
    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_FAILED',
      retryable: false,
      details: { serverId: SERVER_ID, status: 'error', reason: 'auth', viaPlaceholder: true },
    })
  })

  it('一次调用只尝试一次连接：退避重连仍然只属于 manager，占位不自己重试', async () => {
    const wired = setupPlaceholderExecute({
      connect: () => {
        throw temporaryError()
      },
    })
    const { ctx } = placeholderContext()

    await wired.call({ q: 'hello' }, ctx)

    expect(wired.reconnect).toHaveBeenCalledTimes(1)
  })

  it('连接失败不注销占位、不动登记表：「这次没连上」不是「这个服务没有工具」', async () => {
    const wired = setupPlaceholderExecute({
      connect: () => {
        throw temporaryError()
      },
    })
    const { ctx } = placeholderContext()

    await wired.call({ q: 'hello' }, ctx)

    // 缓存更不可能被清：执行器整条链路上根本够不到它（它只吃 registry / manager / 登记表）。
    expect(wired.registry.has(TOOL_NAME, wired.placeholder)).toBe(true)
    expect(wired.claims.get(TOOL_NAME)?.tool).toBe(wired.placeholder)
    expect(wired.claims.namesFor(SERVER_ID)).toEqual([TOOL_NAME])
  })
})

describe('连接超时 → 独立预算，不吃工具调用的硬超时', () => {
  it('超时回 MCP_CONNECT_TIMEOUT 且可重试（不经分类器：没等到结果不等于配置坏了）', async () => {
    const wired = setupPlaceholderExecute({
      connectTimeoutMs: 20,
      // 永不落地的连接：stdio 冷启动卡在下载依赖时就是这样。
      connect: () => new Promise<void>(() => {}),
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_CONNECT_TIMEOUT',
      retryable: true,
      details: { serverId: SERVER_ID, transport: 'stdio', timeoutMs: 20, viaPlaceholder: true },
    })
  })

  it('默认用的是连接自己的 180 秒预算，不是工具调用的 1 小时', () => {
    // 否则一个连不上的 stdio 服务能把一次 run 卡住整整一小时。
    expect(MCP_CONNECT_TIMEOUT_MS).toBe(180_000)
    expect(MCP_CONNECT_TIMEOUT_MS).toBeLessThan(MCP_TOOL_CALL_TIMEOUT_MS)
  })
})
