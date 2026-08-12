// 占位工具的【形状】判据（蓝图第一节的那张表）。生命周期的判据在 placeholderSync.test.ts。

import { TOOL_PROVIDER_NOT_CONNECTED_CODE } from '@web-agent/core/tools/schemaResult'
import type { ToolContext } from '@web-agent/core/tools/types'
import { describe, expect, it } from 'vitest'
import { MCP_CONNECT_TOOL_NAME } from './connect-mcp-server/connect-mcp-server'
import { createMcpPlaceholderTool } from './placeholderTool'
import { createMcpToolAdapter, makeMcpToolName } from './toolAdapter'
import type { McpConnection, McpRemoteTool } from './types'

const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)

function toolContext(): ToolContext {
  return { signal: new AbortController().signal } as unknown as ToolContext
}

/** 与 app 侧 toolNameCacheWriter.toCachedTools 同一口径：存注册名 + 快照描述。 */
function cachedFromAdapter(serverId: string, remoteTool: McpRemoteTool) {
  const adapted = createMcpToolAdapter({
    serverId,
    remoteTool,
    connection: {} as McpConnection,
    runtime: 'internal',
  })
  return {
    entry: { name: adapted.snapshot.name, description: adapted.snapshot.description },
    real: adapted.tool,
  }
}

describe('占位工具的形状', () => {
  it('name 直接取缓存条目名，绝不二次拼接', () => {
    const name = makeMcpToolName('docs', 'search')
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name, description: '搜索文档' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    // 再套一次 makeMcpToolName 会得到 mcp__docs__mcp__docs__search 这种永不命中的名字，
    // 占位也就永远不可能被 reconcile 原地替换。
    expect(tool.name).toBe(name)
    expect(tool.name).toBe('mcp__docs__search')
  })

  it('runtime 由调用方按 runtimeFor(config) 给定：stdio 占位标 server，浏览器下自动被过滤', () => {
    const stdio = createMcpPlaceholderTool({
      serverId: 'local',
      entry: { name: 'mcp__local__run', description: '' },
      runtime: 'server',
      cachedAt: CACHED_AT,
    })

    expect(stdio.runtime).toBe('server')
  })

  it('description 与真实 adapter 逐字节相同——同一个函数、同一份文案', () => {
    const { entry, real } = cachedFromAdapter('docs', {
      name: 'search',
      description: '按关键词搜索文档库',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    })

    const placeholder = createMcpPlaceholderTool({
      serverId: 'docs',
      entry,
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    // 蓝图第八节的头号缓解手段：远端描述在缓存的 160 字符上限以内时，连接前后 manifest
    // 的这一行完全不变，provider 的稳定前缀零失效。
    expect(placeholder.skill.description).toBe(real.skill.description)
  })

  it('缓存里没有描述时退回同一个函数的「无描述」形态，不留一行空描述', () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    expect(tool.skill.description).toContain('from server "docs"')
  })

  it('guide 把四件事都写明：未连接、现在调用会怎样、参数以真实 schema 为准、外部不可信', () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    const guide = tool.skill.content
    expect(guide).toContain('上次已知')
    expect(guide).toContain(MCP_CONNECT_TOOL_NAME)
    expect(guide).toContain('真实 schema')
    expect(guide).toContain('不可信')
  })

  it('inputSchema 只声明「是个对象」：缓存没有 schema，占位绝不编造参数名', () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    expect(tool.inputSchema).toEqual({ type: 'object' })
    expect(tool.inputSchema).not.toHaveProperty('properties')
    expect(tool.inputSchema).not.toHaveProperty('required')
  })

  it('execution 与真实 adapter 的非只读形态一致，不与同服务调用并发交错', () => {
    const { real } = cachedFromAdapter('docs', {
      name: 'search',
      description: '搜索',
      inputSchema: { type: 'object' },
    })
    const placeholder = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    expect(placeholder.execution).toEqual({
      mode: 'serial',
      effectKeys: ['external:mcp:docs'],
    })
    expect(placeholder.execution).toEqual(real.execution)
  })

  it('缓存条目没有名字就不该造出占位', () => {
    expect(() => createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: '  ', description: '' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })).toThrow('cached tool name')
  })
})

describe('占位工具的 execute（D2：只指路，不连接）', () => {
  it('回的是与 core 同源的「该服务尚未连接」结构化回执', async () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })

    const result = await tool.execute({ q: 'hello' }, toolContext())

    expect(result).toMatchObject({
      ok: false,
      code: TOOL_PROVIDER_NOT_CONNECTED_CODE,
      retryable: false,
    })
    const failure = result as { error: string; hint: string; details: Record<string, unknown> }
    expect(failure.error).toContain('docs')
    expect(failure.hint).toContain(MCP_CONNECT_TOOL_NAME)
    expect(failure.details).toMatchObject({
      serverId: 'docs',
      executed: false,
      // 下一步直接给成可执行的调用，模型不需要自己拼。
      nextCall: { name: MCP_CONNECT_TOOL_NAME, arguments: { serverId: 'docs' } },
      // trace 靠它把「撞上占位」与「撞上工具闸门」分开统计。
      viaPlaceholder: true,
    })
    expect(failure.details).toMatchObject({ lastKnownAt: new Date(CACHED_AT).toISOString() })
  })

  it('取消是控制流：signal 已 abort 时抛 AbortError，不降级成一条普通失败', async () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      cachedAt: CACHED_AT,
    })
    const controller = new AbortController()
    // 用显式 Error 作为 reason，与运行时取消这条路一致（internal.ts 的 abortError 会给它
    // 改名成 AbortError）。裸 abort() 在 jsdom 下的 reason 是只读 name 的 DOMException，
    // 那是 abortError 的既有短板，与占位无关。
    controller.abort(new Error('user cancelled'))

    await expect(async () => tool.execute({}, { signal: controller.signal } as ToolContext))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
