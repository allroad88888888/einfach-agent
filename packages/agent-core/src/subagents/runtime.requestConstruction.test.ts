import { describe, expect, it } from 'vitest'
import type { SubagentNodeRecord } from './types'
import {
  childPath,
  context,
  eventsTyped,
  messagesOf,
  namedToolCall,
  requestBody,
  response,
  runtime,
  toolResultFor,
} from './runtime.testHarness'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'

describe('createDelegationRuntime · 请求体构造与工具预载', () => {
  it('defaults an omitted direct-child model tier to Pro', async () => {
    let childModel = ''
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModel = String(body.model)
      return response({ role: 'assistant', content: 'done' })
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'unspecified complexity' }] },
      context(new Map()),
    )

    expect(result.children[0].status).toBe('done')
    expect(childModel).toBe('deepseek-v4-pro')
    await delegateRuntime.dispose?.()
  })

  it('preserves a custom DeepSeek model for child calls instead of substituting Pro or Flash', async () => {
    const childModels: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModels.push(String(body.model))
      return response({ role: 'assistant', content: 'done' })
    }
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: `run-custom-${Math.random()}`,
      settings: { vendor: 'deepseek', model: 'private-deepseek-gateway-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    const writes = new Map<string, string>()

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'extract one bounded fact',
        taskCategory: 'extraction',
        riskLevel: 'low',
      }],
    }, context(writes))

    expect(childModels).toEqual(['private-deepseek-gateway-model'])
    expect(result.children[0]).toMatchObject({
      status: 'done',
      modelTier: 'pro',
      routeReason: 'custom_model_uses_parent_model',
      fallbackCount: 0,
    })
    expect(eventsTyped(writes, 'child_started')[0]?.data).toMatchObject({
      model: 'private-deepseek-gateway-model',
      modelTier: 'pro',
      route_reason: 'custom_model_uses_parent_model',
    })
    expect(
      eventsTyped(writes, 'child_model_usage')
        .find((event) => event.data?.phase === 'subagent')
        ?.data,
    ).toMatchObject({
      vendor: 'deepseek',
      model: 'private-deepseek-gateway-model',
    })
    await delegateRuntime.dispose?.()
  })

  it('loads a child tool schema into the next request without duplicating inputSchema in history', async () => {
    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# distilled skill' })
      childBodies.push(body)
      if (childBodies.length === 1) {
        return namedToolCall('load-read', 'request_tool_schema', {
          toolName: 'read_file',
          reason: '需要读取文件',
        })
      }
      return response({ role: 'assistant', content: '已获得读取能力。' })
    }
    const delegateRuntime = runtime(fetchImpl)
    const writes = new Map<string, string>()

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'inspect',
        mode: 'worker',
        expectedOutput: 'summary',
        maxTurns: 3,
        toolProfile: 'workspace_read',
      }],
      toolProfile: 'workspace_read',
    }, context(writes))

    expect(result.children[0].status).toBe('done')
    expect(childBodies).toHaveLength(2)
    const historyResult = JSON.parse(toolResultFor(childBodies[1], 'load-read')) as Record<string, unknown>
    expect(historyResult).toMatchObject({ loaded: true, toolName: 'read_file' })
    expect(typeof historyResult.guide).toBe('string')
    expect(historyResult).not.toHaveProperty('inputSchema')
    const nextTools = childBodies[1].tools as Array<{
      function: { name: string; parameters?: Record<string, unknown> }
    }>
    expect(nextTools.find((tool) => tool.function.name === 'read_file')?.function.parameters)
      .toMatchObject({ type: 'object' })
    await delegateRuntime.dispose?.()
  })

  it('preloads evaluator read tools and reserves the last turn for synthesis', async () => {
    const childBodies: Record<string, unknown>[] = []
    let explorationCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      const path = childPath(body)
      if (!path) return response({ content: '# skill' })
      childBodies.push(body)
      if (body.tool_choice === 'none') {
        return response({
          content: '{"stage":{"status":"passed","evidence":["ok"],"reason":""}}',
          reasoning_content: '证据已经足够，可以给出验收结论。',
        })
      }
      explorationCalls += 1
      return response({
        role: 'assistant',
        content: '先读取实现文件。',
        reasoning_content: '需要核对真实代码，不能只依据摘要。',
        tool_calls: [{
          id: `read-${explorationCalls}`,
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
        }],
      })
    }
    const delegateRuntime = runtime(fetchImpl)
    const writes = new Map<string, string>()

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'evaluate',
        mode: 'evaluator',
        expectedOutput: 'strict JSON',
        maxTurns: 3,
        toolProfile: 'workspace_read',
      }],
      toolProfile: 'workspace_read',
    }, context(writes))

    expect(result.children[0]).toMatchObject({
      status: 'done',
      summary: '{"stage":{"status":"passed","evidence":["ok"],"reason":""}}',
    })
    expect(childBodies).toHaveLength(3)
    const firstToolNames = (childBodies[0].tools as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(firstToolNames).toEqual(expect.arrayContaining([
      'request_tool_schema',
      'read_file',
      'list_files',
      'search_files',
      'rg_search',
    ]))
    expect(childBodies[2]).toMatchObject({ tool_choice: 'none', tools: [] })
    expect(messagesOf(childBodies[2]).at(-1)?.content).toContain('strict JSON')
    const traceText = [...writes.entries()]
      .find(([path]) => path.endsWith('/traces/root-01.trace.jsonl'))?.[1] ?? ''
    const trace = traceText.trim().split('\n').map((line) => JSON.parse(line) as {
      turn: number
      item: { role: string; reasoning_content?: string; tool_call_id?: string }
    })
    expect(trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        turn: 1,
        item: expect.objectContaining({
          role: 'assistant',
          reasoning_content: '需要核对真实代码，不能只依据摘要。',
        }),
      }),
      expect.objectContaining({
        turn: 1,
        item: expect.objectContaining({ role: 'tool', tool_call_id: 'read-1' }),
      }),
      expect.objectContaining({
        turn: 3,
        item: expect.objectContaining({
          role: 'assistant',
          reasoning_content: '证据已经足够，可以给出验收结论。',
        }),
      }),
    ]))
    await delegateRuntime.dispose?.()
  })

  it('shares one model-call limiter across distillation and children', async () => {
    let active = 0
    let peak = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      {
        children: [{ objective: 'one' }, { objective: 'two' }, { objective: 'three' }],
        maxConcurrent: 2,
      },
      context(writes),
    )

    expect(result.children.every((child) => child.status === 'done')).toBe(true)
    expect(peak).toBe(2)
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root')?.status).toBe('done')
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const events = eventsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    expect(events.find((event) => event.type === 'child_finished')?.data).toMatchObject({
      status: 'done',
      objective: 'one',
      summary: 'done',
    })
    expect(events.find((event) => event.type === 'child_finished')?.data?.skillFiles).toBeInstanceOf(Array)
    expect(events.find((event) => event.type === 'delegate_finished')?.data?.status).toBe('done')
    delegateRuntime.dispose?.()
  })
})
