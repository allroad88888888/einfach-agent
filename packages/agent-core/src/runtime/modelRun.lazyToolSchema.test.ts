// 拆分自 modelRun.test.ts（T1）。T-6 懒加载工具 schema：request_tool_schema、跨 run/重启恢复已加载
// schema、runtime 工具调用、未注册/未加载工具的硬拒绝，以及 schema 重注册后的旧响应防护。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { toolRegistry } from '../tools/registry'
import type { ModelFunctionTool } from '@einfach-agent/ai'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { createCoreInstance } from './core/coreInstance'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, seqFetch, captureTrace } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runSession（多轮 lazy-tool 循环，T-6）懒加载工具 schema', () => {
  it('request_tool_schema：先请求 schema（懒加载）再给最终答案', async () => {
    seedSession('t1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: 'x' } }]),
      () => jsonResponse('最终答案'),
    ])

    await runSession('t1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('t1').store
    const items = store.getter(itemsAtom)
    // user → assistant(tool_calls) → tool(schema) → assistant(final)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])

    const asstTc = items[1].item
    const toolItem = items[2].item
    if (asstTc.role !== 'assistant' || toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(asstTc.tool_calls?.[0].function.name).toBe('request_tool_schema')
    // 缺省 id 由 runtime 自造并一致回填：assistant.tool_calls[0].id === tool.tool_call_id。
    expect(asstTc.tool_calls?.[0].id).toBe(toolItem.tool_call_id)
    // 历史只保留加载确认与 guide；inputSchema 仅在下一轮请求的顶层 tools 中出现。
    const schemaResult = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(schemaResult).toMatchObject({
      loaded: true,
      toolName: 'skill_search',
    })
    expect(typeof schemaResult.guide).toBe('string')
    expect(schemaResult).not.toHaveProperty('inputSchema')

    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
    expect((items[3].item as { content?: string }).content).toBe('最终答案')
  })

  it('新 run 从历史恢复已加载 schema：首个请求放顶层 tools，并保留 loader 历史', async () => {
    seedSession('schema-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('schema-resume').store
    store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user', content: '继续执行' } },
      {
        id: 'schema-call',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'load-search',
            type: 'function',
            function: {
              name: 'request_tool_schema',
              arguments: '{"toolName":"skill_search","reason":"需要搜索"}',
            },
          }],
        },
      },
      {
        id: 'schema-result',
        createdAt: 3,
        item: {
          role: 'tool',
          tool_call_id: 'load-search',
          content: '{"loaded":true,"toolName":"skill_search","guide":"旧 guide"}',
        },
      },
    ])
    setRun('schema-resume', { runId: 'resumed-run', status: 'running' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(init!.body as string) as Record<string, unknown>
      return jsonResponse('已继续')
    }

    await runToolLoop('schema-resume', 'resumed-run', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const sentTools = captured.tools as ModelFunctionTool[]
    expect(sentTools.map((tool) => tool.function.name)).toContain('skill_search')
    const searchTool = sentTools.find((tool) => tool.function.name === 'skill_search')
    const currentSearchTool = toolRegistry.loadSchema('skill_search')
    expect(searchTool?.function.parameters).toEqual(currentSearchTool?.inputSchema)
    expect(searchTool?.function.description).toContain(currentSearchTool?.guide)
    expect(searchTool?.function.description).not.toContain('旧 guide')

    const sentMessages = captured.messages as Array<Record<string, unknown>>
    expect(sentMessages.some((message) =>
      message.role === 'assistant'
      && JSON.stringify(message).includes('request_tool_schema')
    )).toBe(true)
    expect(sentMessages.some((message) =>
      message.role === 'tool'
      && message.tool_call_id === 'load-search'
    )).toBe(true)
    expect(JSON.stringify(sentMessages)).toContain('旧 guide')
    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('应用重启后的新 run 从 SessionMeta 恢复已加载 schema，无需 loader 历史或旧 run', async () => {
    seedSession('schema-restart', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      'schema-restart': {
        ...sessions['schema-restart'],
        loadedTools: ['skill_search'],
      },
    }))
    const store = getSessionStore('schema-restart').store
    store.setter(itemsAtom, [
      { id: 'user-after-restart', createdAt: 1, item: { role: 'user', content: '继续搜索' } },
    ])
    setRun('schema-restart', { runId: 'new-process-run', status: 'running' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_input, init) => {
      captured = JSON.parse(init!.body as string) as Record<string, unknown>
      return jsonResponse('已从持久化工具缓存继续')
    }

    await runToolLoop('schema-restart', 'new-process-run', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const sentTools = captured.tools as ModelFunctionTool[]
    expect(sentTools.map((tool) => tool.function.name)).toContain('skill_search')
    expect(sentTools.find((tool) => tool.function.name === 'skill_search')?.function.parameters)
      .toEqual(toolRegistry.loadSchema('skill_search')?.inputSchema)
    expect(store.getter(runAtom)?.loadedTools).toContain('skill_search')
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('runtime tool：加载 skill_search 后调用它，tool result 含 results', async () => {
    seedSession('t2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: 'skill_search', reason: '需要搜索' } }]),
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'chart' } }]),
      () => jsonResponse('搜索完成'),
    ])

    await runSession('t2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const items = getSessionStore('t2').store.getter(itemsAtom)
    // user → asst(tc schema) → tool(schema) → asst(tc skill_search) → tool(results) → asst(final)
    expect(items.map((it) => it.item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const searchResult = items[4].item
    if (searchResult.role !== 'tool') throw new Error('意外的条目形状')
    expect(searchResult.content.includes('results')).toBe(true)
    expect(getSessionStore('t2').store.getter(runAtom)?.status).toBe('done')
  })

  it('直接调用未加载工具：本次不执行，但就地加载 schema，下一轮起随 tools 长期携带', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('lazy-autoload', { vendor: 'deepseek', model: 'x' })
    const exposedPerRequest: string[][] = []
    const responses: Array<() => Response> = [
      // 首轮 tools 里只有 request_tool_schema；模型凭工具摘要猜了名字（参数还猜错了）。
      () => toolCallsResponse([{ name: 'skill_search', args: { skillName: 'planning' }, id: 'guessed' }]),
      // 关键断言点：模型【不需要】再单发一次 request_tool_schema，直接按真 schema 重发即可。
      () => toolCallsResponse([{ name: 'skill_search', args: { query: 'planning' }, id: 'search' }]),
      () => jsonResponse('已完成'),
    ]
    let index = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { tools: ModelFunctionTool[] }
      exposedPerRequest.push(body.tools.map((tool) => tool.function.name))
      const maker = responses[Math.min(index, responses.length - 1)]
      index += 1
      return maker()
    }

    await runSession('lazy-autoload', '规划任务', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    // 三次请求就收工（旧行为要四次：猜调被拒 → request_tool_schema → 真调用 → 收尾）。
    expect(exposedPerRequest).toHaveLength(3)
    expect(exposedPerRequest[0]).toEqual(['request_tool_schema'])
    expect(exposedPerRequest[1]).toContain('skill_search')
    // 「加载后永久携带」：后续每一轮都还在 tools 里。
    expect(exposedPerRequest[2]).toContain('skill_search')

    const items = getSessionStore('lazy-autoload').store.getter(itemsAtom)
    const autoloaded = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'guessed',
    )?.item
    if (!autoloaded || autoloaded.role !== 'tool') throw new Error('缺少加载结果')
    const payload = JSON.parse(autoloaded.content) as Record<string, unknown>
    expect(payload.code).toBe('tool_schema_autoloaded')
    expect(payload.loaded).toBe(true)
    // 【不执行】：猜出来的 skillName 没有落地成一次真实搜索，结果里只有加载确认与 guide。
    expect(payload.executed).toBe(false)
    expect(payload).not.toHaveProperty('results')
    expect(Object.keys(payload).sort()).toEqual(
      ['code', 'executed', 'guide', 'hint', 'loaded', 'toolName'],
    )
    // 【inputSchema 不进消息历史】：完整 schema 只经顶层 tools 下发。
    expect(autoloaded.content).not.toContain('inputSchema')

    const searchResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'search',
    )?.item
    if (!searchResult || searchResult.role !== 'tool') throw new Error('缺少搜索结果')
    expect(searchResult.content).toContain('results')

    expect(trace.events.some((event) =>
      event.name === 'tool.schema_autoloaded' && event.attrs?.toolName === 'skill_search'
    )).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.schema_not_loaded')).toBe(false)
    expect(getSessionStore('lazy-autoload').store.getter(runAtom)?.status).toBe('done')
  })

  it('未注册的幻觉工具名仍然硬拒绝，不会被当作加载请求', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('lazy-ghost', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{ name: 'totally_unknown_tool', args: { x: 1 }, id: 'ghost' }]),
      () => jsonResponse('收到'),
    ])

    await runSession('lazy-ghost', '干点什么', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const items = getSessionStore('lazy-ghost').store.getter(itemsAtom)
    const ghostResult = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'ghost',
    )?.item
    if (!ghostResult || ghostResult.role !== 'tool') throw new Error('缺少未加载工具结果')
    expect(ghostResult.content).toContain('tool_schema_not_loaded')
    expect(ghostResult.content).toContain('request_tool_schema')
    expect(trace.events.some((event) =>
      event.name === 'tool.schema_not_loaded' && event.attrs?.toolName === 'totally_unknown_tool'
    )).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.schema_autoloaded')).toBe(false)
  })

  it('TP3：web 下直接调用 server 工具仍然硬拒绝，不会被加载进 tools', async () => {
    // 该工具在没有宿主命令桥的环境下既不进工具摘要也不进 tools（本文件不登记桥），
    // 模型调它就是真的调了一个当前环境不存在的能力。
    seedSession('lazy-server-tool', { vendor: 'deepseek', model: 'x' })
    const exposedPerRequest: string[][] = []
    const responses: Array<() => Response> = [
      () => toolCallsResponse([{ name: 'shell_macos', args: { command: 'ls' }, id: 'server-call' }]),
      () => jsonResponse('收到'),
    ]
    let index = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as { tools: ModelFunctionTool[] }
      exposedPerRequest.push(body.tools.map((tool) => tool.function.name))
      const maker = responses[Math.min(index, responses.length - 1)]
      index += 1
      return maker()
    }

    await runSession('lazy-server-tool', '跑个命令', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = getSessionStore('lazy-server-tool').store.getter(itemsAtom)
    const rejected = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'server-call',
    )?.item
    if (!rejected || rejected.role !== 'tool') throw new Error('缺少拒绝结果')
    expect(rejected.content).toContain('tool_schema_not_loaded')
    expect(exposedPerRequest[1]).not.toContain('shell_macos')
  })

  it('模型收到旧 schema 后同名工具被重注册：旧响应不得执行新实例', async () => {
    const core = createCoreInstance()
    const id = 'tool-registration-changed'
    const toolName = 'dynamic_registration_guard'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })

    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    const inputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    }
    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '旧版动态工具', content: '旧版指南：按旧契约调用' },
      inputSchema,
      execute: oldExecute,
    })
    const oldRegistrationVersion = core.tools.registrationVersion(toolName)

    const requestBodies: Array<{ tools?: ModelFunctionTool[] }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { tools?: ModelFunctionTool[] })
      if (requestBodies.length === 1) {
        return toolCallsResponse([{
          name: 'request_tool_schema',
          args: { toolName, reason: '读取动态工具参数' },
          id: 'load-dynamic',
        }])
      }
      if (requestBodies.length === 2) {
        // 请求体已经把旧 schema 发给模型；在旧响应到达前模拟 MCP tools_changed/重连覆盖同名实例。
        core.tools.register({
          name: toolName,
          runtime: 'internal',
          skill: { description: '新版动态工具', content: '新版指南：实现已替换' },
          inputSchema,
          execute: newExecute,
        })
        return toolCallsResponse([{
          name: toolName,
          args: { value: '由旧 schema 生成' },
          id: 'stale-dynamic-call',
        }])
      }
      return jsonResponse('已重新加载工具')
    }

    await runSession(id, '调用动态工具', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const exposedTool = requestBodies[1]?.tools?.find((tool) => tool.function.name === toolName)
    expect(exposedTool?.function.description).toContain('旧版指南')
    expect(exposedTool?.function.description).not.toContain('新版指南')
    expect(core.tools.registrationVersion(toolName)).toBeGreaterThan(oldRegistrationVersion!)
    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()

    const staleResult = core.getSessionStore(id).store.getter(itemsAtom).find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'stale-dynamic-call',
    )?.item
    if (!staleResult || staleResult.role !== 'tool') throw new Error('缺少旧注册调用的拒绝结果')
    expect(JSON.parse(staleResult.content)).toMatchObject({
      code: 'tool_registration_changed',
      expectedRegistrationVersion: oldRegistrationVersion,
      currentRegistrationVersion: core.tools.registrationVersion(toolName),
    })
    expect(requestBodies).toHaveLength(3)
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
  })
})
