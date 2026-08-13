// connect_mcp_server 的入参契约（F2）：serverId 是【此刻已配置服务 ID】的 enum。
//
// 这一层是新增的第一道闸——让模型在 schema 里就看见能选什么，并让 enum 之外的取值在
// registry.run 的校验阶段出局，不进 execute。它【不替代】运行期的登记表准入：
// 「schema 说可以、manager 说不认识」时仍必须被拒，那条契约在 injection.test.ts 里锁着。
import { createToolRegistry } from '@web-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { registerMcpTools } from '../index'
import {
  fakeManager,
  serverSnapshot,
  toolContext,
} from './connect-mcp-server.fixtures'
import {
  MCP_CONNECT_TOOL_NAME,
  createMcpConnectTool,
  type McpConnectManager,
} from './connect-mcp-server'
import {
  MCP_CONNECT_MAX_LISTED_SERVER_IDS,
  MCP_CONNECT_SERVER_ID_MAX_CHARS,
} from './connectInputSchema'

function serverIdProperty(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  return properties?.serverId ?? {}
}

function enumOf(schema: Record<string, unknown> | undefined): unknown {
  return schema ? serverIdProperty(schema).enum : undefined
}

function descriptionOf(schema: Record<string, unknown>): string {
  return String(serverIdProperty(schema).description ?? '')
}

/** 只登记、不连接的服务清单（F6 之后 list() 就是这个形状）。 */
function configured(...ids: string[]) {
  return fakeManager(ids.map((id) => serverSnapshot(id, 'disconnected')))
}

describe('connect_mcp_server · serverId 取值面', () => {
  it('把已配置服务列成 enum，按用户的配置顺序', () => {
    const { manager } = configured('weather', 'github')

    const schema = createMcpConnectTool(manager).inputSchema

    expect(schema).toMatchObject({
      type: 'object',
      required: ['serverId'],
      additionalProperties: false,
      properties: { serverId: { type: 'string', enum: ['weather', 'github'] } },
    })
    expect(descriptionOf(schema)).toContain('enum')
  })

  it('服务增删后 enum 跟着变——loadSchema 每次都重读 getter，无需重新注册工具', () => {
    const { manager, records } = configured('weather')
    const registry = createToolRegistry()
    registerMcpTools(registry, { manager })

    expect(enumOf(registry.loadSchema(MCP_CONNECT_TOOL_NAME)?.inputSchema)).toEqual(['weather'])

    // 用户在设置里加了一个服务：没有任何重新注册动作，下一次 loadSchema 就该看见它。
    records.set('github', serverSnapshot('github', 'disconnected'))
    expect(enumOf(registry.loadSchema(MCP_CONNECT_TOOL_NAME)?.inputSchema))
      .toEqual(['weather', 'github'])

    // 删掉一个：可选项立刻收窄，模型不会再看见一个已经不存在的服务。
    records.delete('weather')
    expect(enumOf(registry.loadSchema(MCP_CONNECT_TOOL_NAME)?.inputSchema)).toEqual(['github'])

    // run 级快照（toolEpoch）钉住的是【成员与注册版本】，schema 内容照样现算——
    // 与 F4 的 skill getter 同一语义，run 中途新装的服务不会被自己的 schema 挡在门外。
    expect(enumOf(registry.snapshot().loadSchema(MCP_CONNECT_TOOL_NAME)?.inputSchema))
      .toEqual(['github'])
  })

  it('enum 之外的取值在 schema 校验阶段就出局，根本进不了 execute', async () => {
    const { manager, reconnect, connect } = configured('weather')
    const registry = createToolRegistry()
    registerMcpTools(registry, { manager })

    const result = await registry.run(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'weather-v2' },
      toolContext(),
    )

    expect(result).toMatchObject({ ok: false })
    // execute 的拒绝一定带 code（MCP_SERVER_NOT_CONFIGURED 等）；这里没有 code，
    // 说明这次是被 schema 挡下的，调用压根没有到达工具本体。
    expect(result).not.toHaveProperty('code')
    expect(reconnect).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('enum 里的取值照常放行，收窄没有误伤正常路径', async () => {
    const { manager, reconnect } = configured('weather')
    const registry = createToolRegistry()
    registerMcpTools(registry, { manager })

    const result = await registry.run(MCP_CONNECT_TOOL_NAME, { serverId: 'weather' }, toolContext())

    expect(result).toMatchObject({ ok: true, data: { serverId: 'weather' } })
    expect(reconnect).toHaveBeenCalledWith('weather', { signal: expect.any(AbortSignal) })
  })

  it('一个服务都没配置时不写空 enum，而是明说「没有可连接的服务」', async () => {
    const { manager } = configured()
    const registry = createToolRegistry()
    registerMcpTools(registry, { manager })

    const schema = createMcpConnectTool(manager).inputSchema
    expect(serverIdProperty(schema)).not.toHaveProperty('enum')
    expect(descriptionOf(schema)).toContain('没有任何已配置的 MCP 服务')

    // 空 enum 会让 schema 不可满足（校验器回一句候选为空的报错）；不写 enum 则调用仍能走到
    // execute，模型拿到的是带 hint 的、说得清下一步的拒绝。
    const result = await registry.run(MCP_CONNECT_TOOL_NAME, { serverId: 'weather' }, toolContext())
    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_SERVER_NOT_CONFIGURED',
      retryable: false,
      details: { configuredServerIds: [] },
    })
  })

  it('服务数超过上限时摘掉 enum 而不是截断——第 51 个服务不能被自己的 schema 判非法', async () => {
    const ids = Array.from(
      { length: MCP_CONNECT_MAX_LISTED_SERVER_IDS + 1 },
      (_unused, index) => `srv-${index}`,
    )
    const { manager, reconnect } = configured(...ids)
    const registry = createToolRegistry()
    registerMcpTools(registry, { manager })

    const schema = createMcpConnectTool(manager).inputSchema
    expect(serverIdProperty(schema)).not.toHaveProperty('enum')
    expect(descriptionOf(schema)).toContain(String(MCP_CONNECT_MAX_LISTED_SERVER_IDS))

    const last = ids[ids.length - 1]
    await expect(registry.run(MCP_CONNECT_TOOL_NAME, { serverId: last }, toolContext()))
      .resolves.toMatchObject({ ok: true, data: { serverId: last } })
    expect(reconnect).toHaveBeenCalledWith(last, { signal: expect.any(AbortSignal) })
  })

  it('读不出登记表时不写 enum，也不谎称「没有服务」', () => {
    const manager: McpConnectManager = {
      get: () => undefined,
      list: () => {
        throw new Error('host wiring is broken')
      },
      reconnect: vi.fn(),
    }

    const schema = createMcpConnectTool(manager).inputSchema

    expect(serverIdProperty(schema)).not.toHaveProperty('enum')
    expect(descriptionOf(schema)).not.toContain('没有任何已配置的 MCP 服务')
    expect(descriptionOf(schema)).toContain('只接受服务 ID')
  })

  it('登记表里本工具永远接受不了的 id 不进 enum（空白、首尾空格、超长、重复）', () => {
    const oversized = 'a'.repeat(MCP_CONNECT_SERVER_ID_MAX_CHARS + 1)
    const manager: McpConnectManager = {
      get: () => undefined,
      reconnect: vi.fn(),
      list: () => [
        serverSnapshot('weather', 'disconnected'),
        serverSnapshot('  ', 'disconnected'),
        serverSnapshot(' padded ', 'disconnected'),
        serverSnapshot(oversized, 'disconnected'),
        serverSnapshot('weather', 'connected'),
      ],
    }

    // 列一个 execute 侧一定会拒的取值，只会白烧模型一轮往返；已连接的服务仍在 enum 里
    // （本工具对它的回答是「已经连着了，这是它的工具清单」）。
    expect(enumOf(createMcpConnectTool(manager).inputSchema)).toEqual(['weather'])
  })
})
