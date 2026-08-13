// 占位工具的【形状】判据（蓝图第一节的那张表）。生命周期的判据在 placeholderSync.test.ts，
// 透明连接 execute 的判据在 placeholderExecute.test.ts —— 本文件只钉「长什么样」，
// 以及「execute 确实是一行委派」。

import type { ToolContext, ToolResult } from '@web-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import type { McpPlaceholderExecutor } from './placeholderExecute'
import { createMcpPlaceholderTool } from './placeholderTool'
import { createMcpToolAdapter, makeMcpToolName } from './toolAdapter'
import type { McpConnection, McpRemoteTool } from './types'

function toolContext(): ToolContext {
  return { signal: new AbortController().signal } as unknown as ToolContext
}

/** 形状用例不关心编排：执行器在这里只是一个可观察的替身。 */
function fakeExecutor(result: ToolResult = { ok: true }) {
  const execute = vi.fn(async (): Promise<ToolResult> => result)
  return { execute } satisfies McpPlaceholderExecutor & { execute: typeof execute }
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
      executor: fakeExecutor(),
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
      executor: fakeExecutor(),
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
      executor: fakeExecutor(),
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
      executor: fakeExecutor(),
    })

    expect(tool.skill.description).toContain('from server "docs"')
  })

  it('guide 把四件事都写明：上次已知、本次调用会先自动连接再执行、参数以真实 schema 为准、外部不可信', () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      executor: fakeExecutor(),
    })

    const guide = tool.skill.content
    expect(guide).toContain('上次已知')
    // D3b 的行为开关：execute 真的会先连接再执行，guide 就必须照实说，不能再让模型
    // 自己去调连接工具（那是 D2 的临时文案）。
    expect(guide).toContain('会先自动连接')
    expect(guide).not.toContain('不执行任何远端操作')
    expect(guide).toContain('真实 schema')
    expect(guide).toContain('不可信')
  })

  it('inputSchema 只声明「是个对象」：缓存没有 schema，占位绝不编造参数名', () => {
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      executor: fakeExecutor(),
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
      executor: fakeExecutor(),
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
      executor: fakeExecutor(),
    })).toThrow('cached tool name')
  })

  it('没有执行器就不该造出占位：guide 已经向模型承诺了「会先自动连接再执行」', () => {
    expect(() => createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      executor: undefined as unknown as McpPlaceholderExecutor,
    })).toThrow('transparent-connect executor')
  })
})

describe('占位工具的 execute（D3b：一行委派给执行器）', () => {
  it('把 serverId、注册名、参数与 ctx 原样交给执行器，形状文件自己不写任何编排', async () => {
    const executor = fakeExecutor({ ok: true, data: { called: true } })
    const tool = createMcpPlaceholderTool({
      serverId: 'docs',
      entry: { name: 'mcp__docs__search', description: '搜索文档' },
      runtime: 'internal',
      executor,
    })
    const ctx = toolContext()

    const result = await tool.execute({ q: 'hello' }, ctx)

    expect(result).toEqual({ ok: true, data: { called: true } })
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith('docs', 'mcp__docs__search', { q: 'hello' }, ctx)
  })
})
