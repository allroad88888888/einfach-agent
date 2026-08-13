import { createToolRegistry } from '@web-agent/core/tools'
import type { Tool } from '@web-agent/core/tools'
import { describe, expect, it } from 'vitest'
// 连接替身与远端工具构造沿用既有 fixtures，不另造一份 FakeConnection。
import { FakeConnection, remoteTool } from './clientManager.reconnect.fixtures'
import { createMcpPlaceholderClaims } from './placeholderClaims'
import { reconcileMcpTools } from './toolReconciler'
import type { McpRegisteredTool, McpServerConfig } from './types'

/**
 * reconcile 与占位共存：冲突判定放行【本服务】占位占着的名字，覆盖阶段释放该登记，
 * 而「抛出即 registry 未被改动」的契约一并覆盖占位登记。
 */

const ALPHA: McpServerConfig = {
  id: 'alpha',
  transport: 'streamable-http',
  url: 'https://alpha.example.test',
}

/** 与占位工具形状无关的替身：本 issue 只关心「谁占着这个名字」。 */
function fakeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: 'stand-in', content: 'stand-in guide' },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

const NO_REGISTERED: ReadonlyMap<string, McpRegisteredTool> = new Map()

describe('reconcileMcpTools 与占位共存', () => {
  it('不接登记表时行为不变：同名已注册工具仍是冲突', async () => {
    const registry = createToolRegistry()
    const existing = fakeTool('mcp__alpha__read')
    registry.register(existing)

    await expect(
      reconcileMcpTools({
        registry,
        config: ALPHA,
        connection: new FakeConnection([remoteTool('read')]),
        registered: NO_REGISTERED,
      }),
    ).rejects.toThrow('MCP tool name conflicts with an existing tool: mcp__alpha__read')
    expect(registry.has('mcp__alpha__read', existing)).toBe(true)
  })

  it('本服务占位占着的名字被放行：真实工具原地覆盖，占位登记释放', async () => {
    const registry = createToolRegistry()
    const claims = createMcpPlaceholderClaims()
    const placeholder = fakeTool('mcp__alpha__read')
    registry.register(placeholder)
    claims.claim('alpha', 'mcp__alpha__read', placeholder)
    const versionBefore = registry.registrationVersion('mcp__alpha__read')

    const next = await reconcileMcpTools({
      registry,
      config: ALPHA,
      connection: new FakeConnection([remoteTool('read')]),
      registered: NO_REGISTERED,
      placeholders: claims,
    })

    const real = next.get('mcp__alpha__read')
    expect(real).toBeDefined()
    // 同一个名字换了实例，并签发更高的注册版本——下一轮才能把占位快照换成真实 schema。
    expect(registry.has('mcp__alpha__read', real!.tool)).toBe(true)
    expect(registry.has('mcp__alpha__read', placeholder)).toBe(false)
    expect(registry.registrationVersion('mcp__alpha__read')).toBeGreaterThan(versionBefore!)
    // 覆盖阶段释放登记：这个名字此后不再算占位的。
    expect(claims.get('mcp__alpha__read')).toBeUndefined()
    expect(claims.namesFor('alpha')).toEqual([])
  })

  it('占位占着名字时不走实例复用：真实工具必须真的被注册进去', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('read')])
    const first = await reconcileMcpTools({
      registry,
      config: ALPHA,
      connection,
      registered: NO_REGISTERED,
    })
    const previousTool = first.get('mcp__alpha__read')!.tool

    // registry 侧已被占位接管，registered 表却还留着上一轮的实例：远端元数据逐字段相同，
    // 复用判定会成立，于是覆盖阶段可能整个跳过 register。
    const placeholder = fakeTool('mcp__alpha__read')
    registry.register(placeholder)
    const claims = createMcpPlaceholderClaims()
    claims.claim('alpha', 'mcp__alpha__read', placeholder)

    const second = await reconcileMcpTools({
      registry,
      config: ALPHA,
      connection,
      registered: first,
      placeholders: claims,
    })

    const real = second.get('mcp__alpha__read')!.tool
    expect(real).not.toBe(previousTool)
    expect(registry.has('mcp__alpha__read', placeholder)).toBe(false)
    expect(registry.has('mcp__alpha__read', real)).toBe(true)
    expect(claims.get('mcp__alpha__read')).toBeUndefined()
  })

  it('别的服务的占位占着这个名字：仍然是冲突，登记不动', async () => {
    const registry = createToolRegistry()
    const claims = createMcpPlaceholderClaims()
    const foreignPlaceholder = fakeTool('mcp__alpha__read')
    registry.register(foreignPlaceholder)
    // 跨服务撞名先到先得的结果：这个名字归 beta，不归正在连接的 alpha。
    claims.claim('beta', 'mcp__alpha__read', foreignPlaceholder)

    await expect(
      reconcileMcpTools({
        registry,
        config: ALPHA,
        connection: new FakeConnection([remoteTool('read')]),
        registered: NO_REGISTERED,
        placeholders: claims,
      }),
    ).rejects.toThrow('MCP tool name conflicts with an existing tool: mcp__alpha__read')
    expect(registry.has('mcp__alpha__read', foreignPlaceholder)).toBe(true)
    expect(claims.owns('beta', 'mcp__alpha__read')).toBe(true)
  })

  it('过期登记不放行：登记说是本服务的，但 registry 里已是别人的注册', async () => {
    const registry = createToolRegistry()
    const claims = createMcpPlaceholderClaims()
    const placeholder = fakeTool('mcp__alpha__read')
    const foreignReal = fakeTool('mcp__alpha__read')
    claims.claim('alpha', 'mcp__alpha__read', placeholder)
    // 占位已被别人的真实工具覆盖，登记却还没释放：此时这个名字不再属于本服务。
    registry.register(foreignReal)

    await expect(
      reconcileMcpTools({
        registry,
        config: ALPHA,
        connection: new FakeConnection([remoteTool('read')]),
        registered: NO_REGISTERED,
        placeholders: claims,
      }),
    ).rejects.toThrow('MCP tool name conflicts with an existing tool: mcp__alpha__read')
    expect(registry.has('mcp__alpha__read', foreignReal)).toBe(true)
  })
})

describe('reconcileMcpTools 的零副作用校验阶段', () => {
  it('校验中途抛错：registry 与占位登记都保持原样', async () => {
    const registry = createToolRegistry()
    const claims = createMcpPlaceholderClaims()
    const placeholder = fakeTool('mcp__alpha__read')
    const foreign = fakeTool('mcp__alpha__write')
    registry.register(placeholder)
    claims.claim('alpha', 'mcp__alpha__read', placeholder)
    registry.register(foreign)

    // 清单里第一个工具命中本服务占位（会被记账），第二个撞上别人的注册（抛错）。
    await expect(
      reconcileMcpTools({
        registry,
        config: ALPHA,
        connection: new FakeConnection([remoteTool('read'), remoteTool('write')]),
        registered: NO_REGISTERED,
        placeholders: claims,
      }),
    ).rejects.toThrow('MCP tool name conflicts with an existing tool: mcp__alpha__write')

    // 一件都没做成：占位仍注册着、登记仍在，真实工具一个都没进 registry。
    expect(registry.has('mcp__alpha__read', placeholder)).toBe(true)
    expect(registry.registrationVersion('mcp__alpha__read')).toBe(1)
    expect(claims.owns('alpha', 'mcp__alpha__read')).toBe(true)
    expect(claims.get('mcp__alpha__read')?.tool).toBe(placeholder)
    expect(registry.has('mcp__alpha__write', foreign)).toBe(true)
  })
})
