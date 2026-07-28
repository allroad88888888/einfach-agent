import { describe, expect, it, vi } from 'vitest'
import { createDelegateAgentRuntime } from './runtime'
import type { DelegateAgentCallContext, SubagentNodeRecord } from './types'
import { createToolRegistry } from '../tools/toolRegistry'

function response(
  message: Record<string, unknown>,
  usage?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    choices: [{ message }],
    ...(usage ? { usage } : {}),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 带 finish_reason 的响应：默认的 response() 不带该字段（等价于正常收尾），
// 用它来伪造 length / content_filter / insufficient_system_resource 三态。
function finishedResponse(message: Record<string, unknown>, finishReason: string): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function toolCall(id: string, args: Record<string, unknown>): Response {
  return namedToolCall(id, 'delegate_agent', args)
}

function namedToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return response({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })
}

// 直接投喂原始 arguments 字符串（绕开 JSON.stringify），用于伪造被截断/非对象的坏参数。
function rawArgsToolCall(id: string, name: string, rawArgs: string): Response {
  return response({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: rawArgs } }],
  })
}

interface TurnMessage {
  role: string
  content?: string
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

function messagesOf(body: Record<string, unknown>): TurnMessage[] {
  return body.messages as TurnMessage[]
}

function toolResultFor(body: Record<string, unknown>, callId: string): string {
  return messagesOf(body).find((message) => message.tool_call_id === callId)?.content ?? ''
}

// 契约：每个 tool_call 在下一轮消息里都必须有对应的 tool 结果，否则序列非法、整个 run 被接口拒。
function orphanToolCallIds(body: Record<string, unknown>): string[] {
  const messages = messagesOf(body)
  const backfilled = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
  )
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id)
    .filter((id) => !backfilled.has(id))
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function childPath(body: Record<string, unknown>): string | undefined {
  const messages = body.messages as Array<{ role: string; content?: string }>
  return messages[0]?.content?.match(/树形子 agent ([^。]+)。/)?.[1]
}

interface ArchiveEvent {
  type: string
  agentPath: string
  data?: Record<string, unknown>
}

// 归档事件日志（events.jsonl）是 append 模式写的，context() 的 writes map 会把它拼成整份正文。
function eventsOf(writes: Map<string, string>): ArchiveEvent[] {
  const raw = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArchiveEvent)
}

function eventsTyped(writes: Map<string, string>, type: string): ArchiveEvent[] {
  return eventsOf(writes).filter((event) => event.type === type)
}

function context(writes: Map<string, string>): DelegateAgentCallContext {
  return {
    parentPath: 'root',
    parentTranscript: 'root transcript',
    progress() {},
    async writeTextFile(input) {
      writes.set(input.path, input.mode === 'append' ? `${writes.get(input.path) ?? ''}${input.content}` : input.content)
      return { ok: true }
    },
  }
}

function runtime(
  fetchImpl: typeof fetch,
  signal = new AbortController().signal,
  deepseekUserId?: string,
) {
  return createDelegateAgentRuntime({
    sessionId: 'session',
    runId: `run-${Math.random()}`,
    settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    deepseekUserId,
    apiKey: 'test-key',
    signal,
    fetchImpl,
  })
}

describe('createDelegateAgentRuntime', () => {
  it('passes the instance-scoped opaque user id to every DeepSeek child request', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(requestBody(init))
      return response({ role: 'assistant', content: 'done' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(
      fetchImpl,
      new AbortController().signal,
      'wa_subagent_0123',
    )

    await delegateRuntime.delegateAgents({
      children: [{ objective: 'inspect one bounded item' }],
    }, context(writes))

    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.every((body) => body.user_id === 'wa_subagent_0123')).toBe(true)

    await delegateRuntime.dispose?.()
  })

  it('archives provider cache usage for child, evaluator, and distill calls', async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 75,
      prompt_cache_miss_tokens: 25,
    }
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      return childPath(body)
        ? response({ role: 'assistant', content: 'done' }, usage)
        : response({ role: 'assistant', content: '# distilled skill' }, usage)
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [
        { objective: 'inspect as worker', mode: 'worker' },
        { objective: 'inspect as evaluator', mode: 'evaluator' },
      ],
    }, context(writes))

    expect(result.children.every((child) => child.status === 'done')).toBe(true)
    const usageEvents = eventsTyped(writes, 'child_model_usage')
    // 一次 core skill + 每个 child 各一次 brief，共 3 次 distill；随后 worker/evaluator 各 1 次。
    expect(usageEvents).toHaveLength(5)
    expect(usageEvents.map((event) => event.data?.phase).sort())
      .toEqual([
        'distill:child_brief',
        'distill:child_brief',
        'distill:core',
        'evaluator',
        'subagent',
      ])
    for (const event of usageEvents) {
      expect(event.data).toMatchObject({
        promptTk: 100,
        completionTk: 20,
        totalTk: 120,
        cacheMetricsStatus: 'available',
        cacheHitTk: 75,
        cacheMissTk: 25,
        cacheMissSource: 'provider',
        cacheHitRate: 0.75,
        cacheProtocolVersion: 'agent-runtime-prefix-v2',
        cacheLane: event.data?.phase,
        compactionBoundary: 'full-history',
        contextCompacted: false,
        withinBudget: true,
      })
      expect(String(event.data?.cacheProfile)).toContain(String(event.data?.phase))
      expect(event.data?.cacheEpoch).toBe(1)
      expect(event.data?.cacheEpochReason).toBe('initial')
      expect(String(event.data?.laneScopeFingerprint)).toMatch(/^scope-v2-fnv1a32-/)
      expect(String(event.data?.systemFingerprint)).toMatch(/^system-v2-fnv1a32-/)
      expect(String(event.data?.requestProjectionFingerprint)).toMatch(/^request-v2-fnv1a32-/)
      expect(String(event.data?.toolSetFingerprint)).toMatch(/^tools-v1-fnv1a32-/)
    }

    const coreDistill = usageEvents.find((event) => event.data?.phase === 'distill:core')
    const childBriefs = usageEvents.filter((event) => event.data?.phase === 'distill:child_brief')
    expect(coreDistill?.agentPath).toBe('root')
    expect(childBriefs.map((event) => event.agentPath).sort()).toEqual(['root-01', 'root-02'])

    await delegateRuntime.dispose?.()
  })

  it('routes Flash by task features at any depth while nested requests without features stay Pro', async () => {
    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      const path = childPath(body)
      if (!path) return response({ role: 'assistant', content: '# distilled skill' })
      childBodies.push(body)
      if (path === 'root-01' && !messagesOf(body).some((message) => message.role === 'tool')) {
        return toolCall('nested', {
          children: [
            // 只声明偏好、无可观测安全特征 → 即使嵌套也拒绝 Flash。
            { objective: 'nested check', modelTier: 'flash' },
            // 完整安全特征 → Flash 资格与深度无关。
            {
              objective: 'nested lookup',
              modelTier: 'flash',
              taskCategory: 'retrieval',
              riskLevel: 'low',
            },
          ],
        })
      }
      return response({ role: 'assistant', content: 'done' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'bounded direct task',
        modelTier: 'flash',
        taskCategory: 'retrieval',
        riskLevel: 'low',
        maxTurns: 3,
      }],
      maxDepth: 3,
    }, context(writes))

    expect(result.children[0].status).toBe('done')
    const modelsByPath = childBodies.reduce<Record<string, string[]>>((models, body) => {
      const path = childPath(body)!
      models[path] = [...(models[path] ?? []), String(body.model)]
      return models
    }, {})
    expect(modelsByPath['root-01']).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash',
    ])
    // 嵌套不再一律 Pro：Flash 只看任务特征。偏好而无特征 → Pro；特征齐全 → Flash。
    expect(modelsByPath['root-01-01']).toEqual(['deepseek-v4-pro'])
    expect(modelsByPath['root-01-02']).toEqual(['deepseek-v4-flash'])

    const started = eventsTyped(writes, 'child_started')
    expect(started.find((event) => event.agentPath === 'root-01')?.data).toMatchObject({
      modelTier: 'flash',
      model: 'deepseek-v4-flash',
      route_reason: 'low_risk_retrieval_uses_flash',
      fallback_count: 0,
    })
    expect(started.find((event) => event.agentPath === 'root-01-01')?.data).toMatchObject({
      modelTier: 'pro',
      model: 'deepseek-v4-pro',
      route_reason: 'flash_request_missing_safe_features',
    })
    expect(started.find((event) => event.agentPath === 'root-01-02')?.data).toMatchObject({
      modelTier: 'flash',
      model: 'deepseek-v4-flash',
      route_reason: 'low_risk_retrieval_uses_flash',
    })

    await delegateRuntime.dispose?.()
  })

  it('routes temporal normalization to Pro and archives the feature', async () => {
    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childBodies.push(body)
      return response({ role: 'assistant', content: 'done' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'normalize events across time zones',
        taskCategory: 'extraction',
        riskLevel: 'low',
        requiresTemporalNormalization: true,
      }],
    }, context(writes))

    expect(result.children.every((child) => child.status === 'done')).toBe(true)
    expect(childBodies.map((body) => [childPath(body), body.model]).sort()).toEqual([
      ['root-01', 'deepseek-v4-pro'],
    ])

    const started = eventsTyped(writes, 'child_started')
    expect(started.find((event) => event.agentPath === 'root-01')?.data).toMatchObject({
      modelTier: 'pro',
      route_reason: 'temporal_normalization_requires_pro',
      requiresTemporalNormalization: true,
    })

    const requestedChildren = eventsTyped(writes, 'delegate_requested')[0]?.data?.children
    expect(requestedChildren).toEqual([
      expect.objectContaining({
        modelTier: 'pro',
        route_reason: 'temporal_normalization_requires_pro',
        requiresTemporalNormalization: true,
      }),
    ])

    await delegateRuntime.dispose?.()
  })

  it('upgrades an eligible Flash child to Pro once and archives the route reason', async () => {
    const childModels: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModels.push(String(body.model))
      return childModels.length === 1
        ? finishedResponse(
            { role: 'assistant', content: null },
            'insufficient_system_resource',
          )
        : response({ role: 'assistant', content: 'recovered by pro' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'extract a bounded fact',
        taskCategory: 'extraction',
        riskLevel: 'low',
      }],
    }, context(writes))

    expect(childModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(result.children[0]).toMatchObject({
      status: 'done',
      summary: 'recovered by pro',
      modelTier: 'pro',
      routeReason: 'prior_failure_requires_pro',
      fallbackCount: 1,
    })
    expect(eventsTyped(writes, 'child_model_escalated')).toHaveLength(1)
    expect(eventsTyped(writes, 'child_model_escalated')[0]?.data).toMatchObject({
      fromModelTier: 'flash',
      toModelTier: 'pro',
      route_reason: 'prior_failure_requires_pro',
      fallback_count: 1,
      trigger: 'insufficient_system_resource',
    })
    expect(eventsTyped(writes, 'child_finished')[0]?.data).toMatchObject({
      modelTier: 'pro',
      route_reason: 'prior_failure_requires_pro',
      fallback_count: 1,
    })

    await delegateRuntime.dispose?.()
  })

  it('does not replay a capacity response that already contains assistant output', async () => {
    const childModels: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModels.push(String(body.model))
      return finishedResponse(
        { role: 'assistant', content: 'provider returned a partial response' },
        'insufficient_system_resource',
      )
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'extract a bounded fact',
        taskCategory: 'extraction',
        riskLevel: 'low',
      }],
    }, context(writes))

    expect(childModels).toEqual(['deepseek-v4-flash'])
    expect(result.children[0]).toMatchObject({
      status: 'failed',
      modelTier: 'flash',
      fallbackCount: 0,
    })
    expect(eventsTyped(writes, 'child_model_escalated')).toHaveLength(0)

    await delegateRuntime.dispose?.()
  })

  it('does not replay malformed tool-call output that cannot be dispatched', async () => {
    const childModels: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModels.push(String(body.model))
      return finishedResponse({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'malformed-call',
          type: 'function',
          function: { arguments: '{}' },
        }],
      }, 'insufficient_system_resource')
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'extract a bounded fact',
        taskCategory: 'extraction',
        riskLevel: 'low',
      }],
    }, context(writes))

    expect(childModels).toEqual(['deepseek-v4-flash'])
    expect(result.children[0]).toMatchObject({
      status: 'failed',
      fallbackCount: 0,
    })
    expect(eventsTyped(writes, 'child_model_escalated')).toHaveLength(0)

    await delegateRuntime.dispose?.()
  })

  it.each([400, 401, 402, 422])(
    'does not upgrade deterministic HTTP %s failures from Flash to Pro',
    async (status) => {
      const childModels: string[] = []
      const fetchImpl: typeof fetch = async (_url, init) => {
        const body = requestBody(init)
        if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
        childModels.push(String(body.model))
        return new Response('deterministic request failure', { status })
      }
      const writes = new Map<string, string>()
      const delegateRuntime = runtime(fetchImpl)

      const result = await delegateRuntime.delegateAgents({
        children: [{
          objective: 'extract a bounded fact',
          taskCategory: 'extraction',
          riskLevel: 'low',
        }],
      }, context(writes))

      expect(childModels).toEqual(['deepseek-v4-flash'])
      expect(result.children[0]).toMatchObject({
        status: 'failed',
        modelTier: 'flash',
        fallbackCount: 0,
      })
      expect(eventsTyped(writes, 'child_model_escalated')).toHaveLength(0)

      await delegateRuntime.dispose?.()
    },
  )

  it.each([
    ['returns without a change set', false],
    ['throws after a possible side effect', true],
  ] as const)('does not auto-upgrade after a same-name read tool %s', async (_case, throwsAfterSideEffect) => {
    const childModels: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ role: 'assistant', content: '# distilled skill' })
      childModels.push(String(body.model))
      return childModels.length === 1
        ? namedToolCall('read-once', 'read_file', { path: 'README.md' })
        : finishedResponse(
            { role: 'assistant', content: null },
            'insufficient_system_resource',
          )
    }
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = async () => {
      if (throwsAfterSideEffect) {
        throw new Error('tool failed after an unobservable side effect')
      }
      return {
        ok: true,
        data: {
          content: 'read result',
        },
      }
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'read one file',
        taskCategory: 'retrieval',
        riskLevel: 'low',
        maxTurns: 3,
      }],
      toolProfile: 'workspace_read',
    }, callContext)

    expect(childModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash'])
    expect(result.children[0]).toMatchObject({
      status: 'failed',
      modelTier: 'flash',
      fallbackCount: 0,
      changeSets: [],
    })
    expect(eventsTyped(writes, 'child_model_escalated')).toHaveLength(0)

    await delegateRuntime.dispose?.()
  })

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
    const delegateRuntime = createDelegateAgentRuntime({
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
      routeReason: 'custom_deepseek_model_uses_parent_model',
      fallbackCount: 0,
    })
    expect(eventsTyped(writes, 'child_started')[0]?.data).toMatchObject({
      model: 'private-deepseek-gateway-model',
      modelTier: 'pro',
      route_reason: 'custom_deepseek_model_uses_parent_model',
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
          content: '{"criteria":[]}',
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
      summary: '{"criteria":[]}',
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

  it('shares one model-call semaphore across distillation and children', async () => {
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

  it('does not deadlock at maxConcurrent=1 and cannot expand the root depth budget', async () => {
    const calls = new Map<string, number>()
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body) ?? 'unknown'
      const count = (calls.get(path) ?? 0) + 1
      calls.set(path, count)
      if (path === 'root-01' && count === 1) {
        return toolCall('nested-1', {
          children: [{ objective: 'grandchild' }],
          maxDepth: 6,
          maxConcurrent: 8,
        })
      }
      if (path === 'root-01-01' && count === 1) {
        return toolCall('nested-2', {
          children: [{ objective: 'must not exist' }],
          maxDepth: 6,
        })
      }
      return response({ content: `${path} done` })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'child', maxDepth: 6 }], maxDepth: 2, maxConcurrent: 1 },
      context(writes),
    )

    expect(result.children[0].status).toBe('done')
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.map((node) => node.path).sort()).toEqual(['root', 'root-01', 'root-01-01'])
    expect(calls.get('root-01-01')).toBe(2)
    delegateRuntime.dispose?.()
  })

  it('lets a nested branch lower its child execution concurrency', async () => {
    let activeGrandchildren = 0
    let peakGrandchildren = 0
    let rootChildCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body) ?? 'unknown'
      if (path === 'root-01') {
        rootChildCalls += 1
        if (rootChildCalls === 1) {
          return toolCall('nested-lower', {
            children: [{ objective: 'one' }, { objective: 'two' }, { objective: 'three' }],
            maxConcurrent: 1,
          })
        }
        return response({ content: 'parent done' })
      }
      activeGrandchildren += 1
      peakGrandchildren = Math.max(peakGrandchildren, activeGrandchildren)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeGrandchildren -= 1
      return response({ content: `${path} done` })
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3, maxConcurrent: 4 },
      context(new Map()),
    )

    expect(result.children[0].status).toBe('done')
    expect(peakGrandchildren).toBe(1)
    delegateRuntime.dispose?.()
  })

  it('enforces a child maxChildren budget on its nested delegation', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body)
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (path === 'root-01' && !messages.some((message) => message.role === 'tool')) {
        return toolCall('too-many', {
          children: [{ objective: 'one' }, { objective: 'two' }],
          maxChildren: 12,
        })
      }
      const toolMessage = messages.find((message) => message.role === 'tool')?.content ?? ''
      expect(toolMessage).toContain('exceeds inherited maxChildren 1')
      return response({ content: 'recovered from limit' })
    }
    const delegateRuntime = runtime(fetchImpl)
    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'child', maxChildren: 1 }], maxDepth: 3 },
      context(new Map()),
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered from limit' })
    delegateRuntime.dispose?.()
  })

  it('shares a hard total-node budget across nested branches and ignores descendant expansion', async () => {
    let parentCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body)
      if (path === 'root-01') {
        parentCalls += 1
        if (parentCalls === 1) {
          return toolCall('node-budget', {
            children: [{ objective: 'one' }, { objective: 'two' }],
            maxTotalNodes: 999,
          })
        }
        const messages = body.messages as Array<{ role: string; content?: string }>
        const toolMessage = messages.find((message) => message.role === 'tool')?.content ?? ''
        expect(toolMessage).toContain('subagent tree node budget exhausted')
        expect(toolMessage).toContain('requested 2, remaining 1, used 2 of 3')
        return response({ content: 'recovered from node budget' })
      }
      return response({ content: 'unexpected child' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3, maxTotalNodes: 3 },
      context(writes),
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered from node budget' })
    expect(result.budgetUsage?.totalNodes).toEqual({ used: 2, limit: 3 })
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.map((node) => node.path).sort()).toEqual(['root', 'root-01'])
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    const exhausted = events.find((event) => event.type === 'delegate_finished' && event.data?.error)
    expect(exhausted?.data?.budgetUsage).toMatchObject({ totalNodes: { used: 2, limit: 3 } })
    delegateRuntime.dispose?.()
  })

  it('counts distillation calls and fails reserved nodes cleanly when model-call budget is exhausted', async () => {
    let fetchCalls = 0
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1
      return response({ content: '# skill' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'cannot start' }], maxModelCalls: 2 },
      context(writes),
    )

    expect(fetchCalls).toBe(2)
    expect(result.children[0]).toMatchObject({
      status: 'failed',
      error: 'subagent tree model-call budget exhausted: used 2 of 2',
    })
    expect(result.budgetUsage).toEqual({
      totalNodes: { used: 2, limit: 64 },
      modelCalls: { used: 2, limit: 2 },
    })
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root')?.status).toBe('failed')
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    expect(tree.nodes.some((node) => node.status === 'running' || node.status === 'distilling')).toBe(false)
    delegateRuntime.dispose?.()
  })

  it('returns cancelled children and persists the final snapshot on abort', async () => {
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl, controller.signal)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'cancel me' }] },
      context(writes),
    )

    expect(result.children[0].status).toBe('cancelled')
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root')?.status).toBe('cancelled')
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('cancelled')
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    expect(eventsText).toContain('"type":"child_finished"')
    expect(eventsText).toContain('"type":"delegate_finished"')
    await delegateRuntime.dispose?.()
  })

  it('does not charge a model call that aborts while waiting for a concurrency permit', async () => {
    const controller = new AbortController()
    let fetchCalls = 0
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(async () => {
      fetchCalls += 1
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }, controller.signal)

    await expect(
      delegateRuntime.delegateAgents(
        { children: [{ objective: 'cancel while distilling' }], maxConcurrent: 1 },
        context(writes),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetchCalls).toBe(1)
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    const finished = events.find((event) => event.type === 'delegate_finished')
    expect(finished?.data).toMatchObject({
      status: 'cancelled',
      budgetUsage: { modelCalls: { used: 1, limit: 128 } },
    })
    delegateRuntime.dispose?.()
  })

  it('marks reserved nodes failed and attempts a final snapshot when distillation fails', async () => {
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') throw new Error('distillation unavailable')
      return response({ content: 'unused' })
    })

    await expect(
      delegateRuntime.delegateAgents(
        { children: [{ objective: 'cannot distill' }] },
        context(writes),
      ),
    ).rejects.toThrow('distillation unavailable')

    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root')?.status).toBe('failed')
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const events = eventsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    expect(events.find((event) => event.type === 'delegate_finished')?.data?.status).toBe('failed')
    const usageFailures = events.filter((event) => event.type === 'child_model_usage')
    expect(usageFailures.length).toBeGreaterThan(0)
    for (const usageFailure of usageFailures) {
      expect(['distill:core', 'distill:child_brief']).toContain(usageFailure.data?.phase)
      expect(usageFailure.data).toMatchObject({
        cacheMetricsStatus: 'request_failed',
        cacheLane: usageFailure.data?.phase,
        cacheEpoch: 1,
        cacheEpochReason: 'initial',
      })
      expect(usageFailure.data).not.toHaveProperty('promptTk')
      expect(usageFailure.data).not.toHaveProperty('cacheHitTk')
      expect(usageFailure.data).not.toHaveProperty('cacheMissTk')
    }
    delegateRuntime.dispose?.()
  })

  it('throws when an injected archive writer reports ok:false', async () => {
    const delegateRuntime = runtime(async () => response({ content: '# skill' }))
    await expect(
      delegateRuntime.delegateAgents(
        { children: [{ objective: 'child' }] },
        {
          parentPath: 'root',
          progress() {},
          async writeTextFile() {
            return { ok: false, error: 'disk full' }
          },
        },
      ),
    ).rejects.toThrow('disk full')
    delegateRuntime.dispose?.()
  })

  it('batches high-frequency skill and agent index appends but not audit events', async () => {
    const writes: Array<{ path: string; content: string; mode?: string }> = []
    const delegateRuntime = runtime(async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    })
    const callContext: DelegateAgentCallContext = {
      parentPath: 'root',
      parentTranscript: 'root transcript',
      progress() {},
      async writeTextFile(input) {
        writes.push(input)
        return { ok: true }
      },
    }

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'one' }, { objective: 'two' }, { objective: 'three' }] },
      callContext,
    )
    await delegateRuntime.dispose?.()

    const skillIndexWrites = writes.filter((write) => write.path.endsWith('/index/skills.jsonl'))
    const agentIndexWrites = writes.filter((write) => write.path.endsWith('/index/agents.jsonl'))
    const runIndexRecords = writes
      .filter((write) => write.path.endsWith('/index/runs.jsonl'))
      .flatMap((write) => write.content.trim().split('\n').map((line) => JSON.parse(line)))
    const eventWrites = writes.filter((write) => write.path.endsWith('/events.jsonl'))
    expect(skillIndexWrites).toHaveLength(1)
    expect(skillIndexWrites[0].content.trim().split('\n')).toHaveLength(4)
    expect(agentIndexWrites).toHaveLength(1)
    expect(agentIndexWrites[0].content.trim().split('\n')).toHaveLength(4)
    expect(runIndexRecords.map((record) => record.status)).toEqual(['running', 'delegated'])
    expect(runIndexRecords[1].updatedAt >= runIndexRecords[0].updatedAt).toBe(true)
    expect(eventWrites.length).toBeGreaterThan(4)
    expect(eventWrites.every((write) => write.content.trim().split('\n').length === 1)).toBe(true)
  })

  it('retries archive initialization after the first write failure', async () => {
    let failedOnce = false
    let conversationWrites = 0
    const delegateRuntime = runtime(async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    })
    const retryContext: DelegateAgentCallContext = {
      parentPath: 'root',
      progress() {},
      async writeTextFile(input) {
        if (input.path.endsWith('/conversation.json')) {
          conversationWrites += 1
          if (!failedOnce) {
            failedOnce = true
            return { ok: false, error: 'temporary failure' }
          }
        }
        return { ok: true }
      },
    }

    await expect(
      delegateRuntime.delegateAgents({ children: [{ objective: 'first' }] }, retryContext),
    ).rejects.toThrow('temporary failure')
    const result = await delegateRuntime.delegateAgents({ children: [{ objective: 'retry' }] }, retryContext)

    expect(result.children[0].status).toBe('done')
    expect(conversationWrites).toBe(2)
    delegateRuntime.dispose?.()
  })

  it('keeps child agents delegate-only by default and rejects workspace reads', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'secret' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('read-1', 'read_file', { path: 'src/a.ts' })
      }
      expect(messages.find((message) => message.role === 'tool')?.content).toContain(
        'tool not allowed for child agent: read_file',
      )
      return response({ content: 'recovered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({ children: [{ objective: 'read' }] }, callContext)

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered' })
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  it('allows workspace reads when opted in without archiving file contents', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'private-file-body' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('read-2', 'read_file', { path: 'src/a.ts' })
      }
      expect(messages.find((message) => message.role === 'tool')?.content).toContain('private-file-body')
      return response({ content: 'read complete' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'read complete' })
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    expect(eventsText).toContain('child_tool_finished')
    expect(eventsText).toContain('workspace_read')
    expect(eventsText).not.toContain('private-file-body')
    delegateRuntime.dispose?.()
  })

  it('dispatches the verification tool for workspace_verify and permits project shell commands', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: { exitCode: 0, stdout: '6 passed', stderr: '' },
    }))
    const systemPrompts: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      if (childPath(body)) systemPrompts.push(messages[0]?.content ?? '')
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('verify-1', 'run_verification_command', { command: 'pnpm test' })
      }
      expect(toolResultFor(body, 'verify-1')).toContain('6 passed')
      return response({ content: 'verified' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      {
        children: [{ objective: 'verify stage' }],
        toolProfile: 'workspace_verify',
      },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'verified' })
    expect(runChildTool).toHaveBeenCalledWith(
      'run_verification_command',
      { command: 'pnpm test' },
      expect.any(Number),
    )
    expect(systemPrompts[0]).toContain('run_verification_command')
    expect(systemPrompts[0]).toContain('验收所需的 shell 命令及项目脚本')
    delegateRuntime.dispose?.()
  })

  it('states the shell verification capability for every workspace_verify child', async () => {
    const writes = new Map<string, string>()
    const systemPrompts: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (childPath(body)) systemPrompts.push(messagesOf(body)[0]?.content ?? '')
      return response({ content: 'no evidence available' })
    }
    const callContext = context(writes)
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'verify stage' }], toolProfile: 'workspace_verify' },
      callContext,
    )

    expect(systemPrompts[0]).toContain('run_verification_command')
    expect(systemPrompts[0]).toContain('验收所需的 shell 命令及项目脚本')
    delegateRuntime.dispose?.()
  })

  it('keeps the verification tool out of reach for workspace_read children', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { stdout: 'ran' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('verify-2', 'run_verification_command', { command: 'pnpm test' })
      }
      expect(toolResultFor(body, 'verify-2')).toContain(
        'tool not allowed for child agent: run_verification_command',
      )
      return response({ content: 'recovered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered' })
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  // 孩子的 maxTurns 默认只有 4 且最后一轮留给合成，先花一整轮做能力发现等于砍掉三分之一预算。
  // 授权集在 spawn 时就已收窄到个位数，整体预载即可，于是「直接调用」在第一轮就能真干活。
  it('预载整个授权集：孩子首轮直接调用即执行，不为能力发现白烧一轮', async () => {
    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      childBodies.push(body)
      // 第一轮就不先 request_tool_schema，直接指名道姓调用 —— 正是主循环里撞闸门的那个行为。
      if (childBodies.length === 1) {
        return namedToolCall('first-read', 'read_file', { path: 'src/a.ts' })
      }
      return response({ role: 'assistant', content: '读完了。' })
    }
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'file body' } }))
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'inspect',
        mode: 'worker',
        expectedOutput: 'summary',
        maxTurns: 3,
        toolProfile: 'workspace_read',
      }],
      toolProfile: 'workspace_read',
    }, callContext)

    const firstTurnTools = (childBodies[0].tools as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(firstTurnTools).toEqual(expect.arrayContaining([
      'request_tool_schema',
      'delegate_agent',
      'read_file',
      'list_files',
      'search_files',
      'rg_search',
    ]))
    // 首轮那次直接调用真的执行了（没有被闸门转成一次加载）。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(Number))
    expect(result.children[0].status).toBe('done')
    await delegateRuntime.dispose?.()
  })

  // 与主循环逐条对齐：判据是「本轮实际发出去的 tools」。注册态中途变化把工具挤出本轮 tools 时，
  // 直接调用【不执行】，改当作一次加载 —— 旧行为是「已授权就直接跑」，会拿模型猜的参数执行。
  it('授权工具不在本轮 tools 里时：直接调用不执行，就地加载后下一轮回到 tools', async () => {
    const isolatedRegistry = createToolRegistry()
    const readFileTool = {
      name: 'read_file',
      runtime: 'server' as const,
      skill: { description: 'isolated reader', content: 'GUIDE' },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => ({ ok: true as const, data: { source: 'isolated' } }),
    }
    isolatedRegistry.register(readFileTool)
    isolatedRegistry.register({
      ...readFileTool,
      name: 'list_files',
      skill: { description: 'isolated lister', content: 'GUIDE' },
    })

    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      childBodies.push(body)
      if (childBodies.length === 1) {
        // 本轮结束后注销 read_file：下一轮 refresh 会把它挤出 visible，于是不进那一轮的 tools。
        // 本轮仍要发一次工具调用，否则孩子直接收尾、走不到下一轮。
        isolatedRegistry.unregister('read_file')
        return namedToolCall('keep-going', 'list_files', { path: 'src' })
      }
      if (childBodies.length === 2) {
        // 请求已发出（tools 里没有 read_file），此刻重连补回注册 —— 模拟 MCP 重连。
        isolatedRegistry.register(readFileTool)
        return namedToolCall('blind-read', 'read_file', { path: 'src/a.ts' })
      }
      if (childBodies.length === 3) {
        return namedToolCall('real-read', 'read_file', { path: 'src/a.ts' })
      }
      return response({ role: 'assistant', content: '读完了。' })
    }
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { source: 'host' } }))
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-subagent-autoload',
      settings: { vendor: 'deepseek', model: 'test-model' },
      registry: isolatedRegistry,
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'inspect', maxTurns: 6, toolProfile: 'workspace_read' }],
      toolProfile: 'workspace_read',
    }, callContext)

    const toolNamesOf = (body: Record<string, unknown>): string[] =>
      (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    // 第 2 次请求：read_file 已被挤出 tools。
    expect(toolNamesOf(childBodies[1])).not.toContain('read_file')
    // 那一轮的盲调没有执行，只换回一次加载确认。
    const blindResult = JSON.parse(toolResultFor(childBodies[2], 'blind-read')) as Record<string, unknown>
    expect(blindResult).toMatchObject({
      loaded: true,
      toolName: 'read_file',
      code: 'tool_schema_autoloaded',
      executed: false,
    })
    expect(blindResult).not.toHaveProperty('inputSchema')
    // 第 3 次请求起 read_file 回到 tools，这一次才真执行。
    expect(toolNamesOf(childBodies[2])).toContain('read_file')
    // 总共只执行两次：第 1 轮的 list_files 与第 3 轮的 read_file。第 2 轮那次盲调没算数。
    expect(runChildTool).toHaveBeenCalledTimes(2)
    expect(runChildTool).toHaveBeenCalledWith('list_files', { path: 'src' }, expect.any(Number))
    expect(runChildTool).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(Number))
    expect(result.children[0].status).toBe('done')
    await delegateRuntime.dispose?.()
  })

  it('uses one injected registry for child manifest, schema loading, version snapshot, and execution', async () => {
    const isolatedRegistry = createToolRegistry()
    isolatedRegistry.register({
      name: 'read_file',
      runtime: 'server',
      skill: {
        description: 'isolated registry reader',
        content: 'ISOLATED_REGISTRY_GUIDE',
      },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isolatedPath: { type: 'string' },
        },
        required: ['isolatedPath'],
      },
      execute: async () => ({ ok: true, data: { source: 'isolated registry' } }),
    })
    const expectedRegistrationVersion = isolatedRegistry.registrationVersion('read_file')
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: { source: 'host execution' },
    }))
    let manifestResultBody: Record<string, unknown> | undefined
    let loadedRequestBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# isolated skill' })
      if (!toolResultFor(body, 'isolated-manifest')) {
        return namedToolCall('isolated-manifest', 'request_tool_schema', {
          query: 'isolated',
          reason: 'discover the isolated reader',
        })
      }
      if (!toolResultFor(body, 'isolated-load')) {
        manifestResultBody = body
        return namedToolCall('isolated-load', 'request_tool_schema', {
          toolName: 'read_file',
          reason: 'load the isolated reader',
        })
      }
      if (!toolResultFor(body, 'isolated-read')) {
        loadedRequestBody = body
        return namedToolCall('isolated-read', 'read_file', {
          isolatedPath: 'src/isolated.ts',
        })
      }
      return response({ content: 'isolated read complete' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-isolated-registry',
      settings: { vendor: 'deepseek', model: 'test-model' },
      registry: isolatedRegistry,
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'inspect isolated registry', maxTurns: 6 }],
      toolProfile: 'workspace_read',
    }, callContext)

    expect(result.children[0]).toMatchObject({
      status: 'done',
      summary: 'isolated read complete',
    })
    const manifest = JSON.parse(
      toolResultFor(manifestResultBody!, 'isolated-manifest'),
    ) as { items: unknown[] }
    expect(manifest.items).toEqual([{
      name: 'read_file',
      description: 'isolated registry reader',
      runtime: 'server',
    }])
    const exposedTools = loadedRequestBody?.tools as Array<{
      function: {
        name: string
        description: string
        parameters: Record<string, unknown>
      }
    }>
    const exposedReadFile = exposedTools.find((tool) => tool.function.name === 'read_file')
    expect(exposedReadFile?.function.description).toContain('ISOLATED_REGISTRY_GUIDE')
    expect(exposedReadFile?.function.parameters).toMatchObject({
      required: ['isolatedPath'],
      properties: { isolatedPath: { type: 'string' } },
    })
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { isolatedPath: 'src/isolated.ts' },
      expectedRegistrationVersion,
    )
    delegateRuntime.dispose?.()
  })

  it('requires a correctly scoped host capability before granting a dangerous tool', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { ok: true } }))
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(async () => response({ content: '# skill' }))

    await expect(delegateRuntime.delegateAgents({
      children: [{ objective: 'write' }],
      confirmedTools: ['write_file'],
    }, callContext)).rejects.toThrow('cannot exceed the verified parent capability')

    callContext.dangerousToolCapability = {
      sessionId: 'other-session',
      runId: 'other-run',
      delegationCallId: 'delegate-1',
      parentPath: 'root',
      toolNames: ['write_file'],
    }
    callContext.delegationCallId = 'different-call'
    await expect(delegateRuntime.delegateAgents({
      children: [{ objective: 'write' }],
      confirmedTools: ['write_file'],
    }, callContext)).rejects.toThrow('cannot exceed the verified parent capability')
    callContext.delegationCallId = 'delegate-1'
    callContext.dangerousToolCapability.runId = 'other-run'
    await expect(delegateRuntime.delegateAgents({
      children: [{ objective: 'write' }],
      confirmedTools: ['write_file'],
    }, callContext)).rejects.toThrow('cannot exceed the verified parent capability')
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  it('executes only the explicit subset of a verified dangerous-tool capability and archives it', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { ok: true } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('write-1', 'write_file', { path: 'a.txt', content: 'ok' })
      }
      return response({ content: 'write complete' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    callContext.dangerousToolCapability = {
      sessionId: 'session',
      runId: 'run-capability',
      delegationCallId: 'delegate-1',
      parentPath: 'root',
      toolNames: ['write_file', 'apply_patch'],
    }
    callContext.delegationCallId = 'delegate-1'
    const stableRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-capability',
      settings: { vendor: 'deepseek', model: 'test-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    const result = await stableRuntime.delegateAgents({
      children: [{ objective: 'write', confirmedTools: ['write_file'] }],
      confirmedTools: ['write_file'],
    }, callContext)

    expect(result.status).toBe('done')
    expect(runChildTool).toHaveBeenCalledWith(
      'write_file',
      { path: 'a.txt', content: 'ok' },
      expect.any(Number),
    )
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    expect(eventsText).toContain('"confirmedTools":["write_file"]')
    expect(eventsText).not.toContain('apply_patch')
    stableRuntime.dispose?.()
  })

  it('aggregates reversible change sets from child tool results for parent rollback', async () => {
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: {
        ok: true,
        changeSet: { id: 'child-change-1', reversible: true },
      },
    }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string }>
      return messages.some((message) => message.role === 'tool')
        ? response({ content: 'write complete' })
        : namedToolCall('write-change', 'write_file', { path: 'a.txt', content: 'ok' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    callContext.dangerousToolCapability = {
      sessionId: 'session',
      runId: 'run-change-sets',
      delegationCallId: 'delegate-change-sets',
      parentPath: 'root',
      toolNames: ['write_file'],
    }
    callContext.delegationCallId = 'delegate-change-sets'
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-change-sets',
      settings: { vendor: 'deepseek', model: 'test-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'write', confirmedTools: ['write_file'] }],
      confirmedTools: ['write_file'],
    }, callContext)

    expect(result.changeSets).toEqual([{ id: 'child-change-1', reversible: true }])
    expect(result.reversible).toBe(true)
    expect(result.children[0]?.changeSets).toEqual([
      { id: 'child-change-1', reversible: true },
    ])
    delegateRuntime.dispose?.()
  })

  it('rejects child capability widening before starting children', async () => {
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-capability-widen',
      settings: { vendor: 'deepseek', model: 'test-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl: async () => response({ content: '# skill' }),
    })
    const callContext = context(new Map())
    callContext.dangerousToolCapability = {
      sessionId: 'session',
      runId: 'run-capability-widen',
      delegationCallId: 'delegate-2',
      parentPath: 'root',
      toolNames: ['write_file', 'apply_patch'],
    }
    callContext.delegationCallId = 'delegate-2'
    await expect(delegateRuntime.delegateAgents({
      children: [{ objective: 'widen', confirmedTools: ['write_file', 'apply_patch'] }],
      confirmedTools: ['write_file'],
    }, callContext)).rejects.toThrow('child confirmedTools cannot widen')
    delegateRuntime.dispose?.()
  })

  it('does not pass a dangerous capability through an omitted nested confirmedTools field', async () => {
    const calls = new Map<string, number>()
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { ok: true } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body) ?? 'unknown'
      const count = (calls.get(path) ?? 0) + 1
      calls.set(path, count)
      if (path === 'root-01' && count === 1) {
        return toolCall('nested-no-confirmation', { children: [{ objective: 'must not write' }] })
      }
      if (path === 'root-01-01' && count === 1) {
        return namedToolCall('write-denied', 'write_file', { path: 'denied.txt', content: 'no' })
      }
      return response({ content: `${path} done` })
    }
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-nested-capability',
      settings: { vendor: 'deepseek', model: 'test-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    callContext.delegationCallId = 'root-delegate'
    callContext.dangerousToolCapability = {
      sessionId: 'session',
      runId: 'run-nested-capability',
      delegationCallId: 'root-delegate',
      parentPath: 'root',
      toolNames: ['write_file'],
    }

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'parent', confirmedTools: ['write_file'] }],
      confirmedTools: ['write_file'],
      maxDepth: 3,
    }, callContext)

    expect(result.status).toBe('done')
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  it.each([
    ['parallel_wait_all', 'failed', 'failed'],
    ['parallel_best_effort', 'partial', 'done'],
  ] as const)('reports mixed child outcomes for %s as %s while preserving node details', async (strategy, expectedStatus, rootStatus) => {
    const writes = new Map<string, string>()
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      return childPath(body) === 'root-01'
        ? new Response('boom', { status: 500 })
        : response({ content: 'second completed' })
    }
    const delegateRuntime = runtime(fetchImpl)
    const result = await delegateRuntime.delegateAgents({
      strategy,
      children: [{ objective: 'fails' }, { objective: 'continues' }],
    }, context(writes))

    expect(result.status).toBe(expectedStatus)
    expect(result.summary).toEqual({ total: 2, done: 1, failed: 1, cancelled: 0 })
    expect(result.children.map((child) => child.status)).toEqual(['failed', 'done'])
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root')?.status).toBe(rootStatus)
    expect(tree.nodes.find((node) => node.path === 'root-01')?.error).toBeTruthy()
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    expect(eventsText).toContain(`"status":"${expectedStatus}"`)
    expect(eventsText).toContain('"failed":1')
    delegateRuntime.dispose?.()
  })

  it('inherits an omitted nested workspace-read profile', async () => {
    const readCalls = vi.fn(async () => ({ ok: true as const, data: { content: 'ok' } }))
    const calls = new Map<string, number>()
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const path = childPath(body) ?? 'unknown'
      const count = (calls.get(path) ?? 0) + 1
      calls.set(path, count)
      if (path === 'root-01' && count === 1) {
        return toolCall('nested-inherit', { children: [{ objective: 'grandchild read' }] })
      }
      if (path === 'root-01-01' && count === 1) {
        return namedToolCall('read-3', 'read_file', { path: 'src/a.ts' })
      }
      return response({ content: `${path} done` })
    }
    const callContext = context(new Map())
    callContext.runChildTool = readCalls
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3, toolProfile: 'workspace_read' },
      callContext,
    )
    expect(result.children[0].status).toBe('done')
    expect(readCalls).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    delegateRuntime.dispose?.()
  })

  it('rejects a descendant attempt to widen delegate-only to workspace-read', async () => {
    let childCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      childCalls += 1
      if (childCalls === 1) {
        return toolCall('nested-widen', {
          children: [{ objective: 'must not start' }],
          toolProfile: 'workspace_read',
        })
      }
      const messages = body.messages as Array<{ role: string; content?: string }>
      expect(messages.find((message) => message.role === 'tool')?.content).toContain(
        'cannot widen inherited delegate_only',
      )
      return response({ content: 'widen rejected' })
    }
    const delegateRuntime = runtime(fetchImpl)
    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3 },
      context(new Map()),
    )
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'widen rejected' })
    delegateRuntime.dispose?.()
  })

  // ---------------------------------------------------------------------------
  // 坏 JSON 工具参数（子 agent 循环）
  // ---------------------------------------------------------------------------
  // 回归背景：这条子循环曾用 safeParseArgs，把被 finish_reason='length' 截断的半截 arguments
  // 静默降级成 {} 再照常执行工具 —— 子 agent 只会收到一个误导性的「缺参数」报错，去改参数值
  // 而不是重发 JSON。现在改成：不执行工具 + 回填一条说明 JSON 坏了的 tool 结果。
  it('does not execute a tool whose arguments are truncated JSON and backfills a parse error', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'private-file-body' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 模型被截断，吐出半截 arguments。
        return rawArgsToolCall('bad-args-1', 'read_file', '{"path": "src/a.t')
      }
      secondTurnBody = body
      return response({ content: 'resent with valid json' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 工具没被执行（旧实现会拿 {} 去调 read_file）。
    expect(runChildTool).not.toHaveBeenCalled()
    // 但结果被回填了，循环得以继续。
    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    const toolResult = JSON.parse(toolResultFor(secondTurnBody!, 'bad-args-1')) as Record<string, string>
    expect(toolResult.error).toContain('不是合法 JSON')
    expect(toolResult.hint).toContain('完整合法的 JSON 对象')
    expect(toolResult.argumentsPreview).toBe('{"path": "src/a.t')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'resent with valid json' })
    delegateRuntime.dispose?.()
  })

  it('rejects a delegate_agent call with non-object arguments instead of delegating', async () => {
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 合法 JSON，但不是对象 —— 同样不能拿它当 {} 去派生下一层。
        return rawArgsToolCall('bad-args-2', 'delegate_agent', '["grandchild"]')
      }
      secondTurnBody = body
      return response({ content: 'nested delegation skipped' })
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3 },
      context(new Map()),
    )

    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    const toolResult = JSON.parse(toolResultFor(secondTurnBody!, 'bad-args-2')) as Record<string, string>
    expect(toolResult.error).toContain('必须是 JSON 对象')
    expect(toolResult.error).toContain('array')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'nested delegation skipped' })
    // 只有 parent 一个节点被计费 —— 坏参数没有派生出孙子节点。
    expect(result.summary).toMatchObject({ total: 1, done: 1, failed: 0 })
    delegateRuntime.dispose?.()
  })

  it('backfills every tool call when one of a sibling batch has bad arguments', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'good-file-body' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'sib-bad', type: 'function', function: { name: 'read_file', arguments: '{"path": ' } },
            {
              id: 'sib-good',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/b.ts' }) },
            },
          ],
        })
      }
      secondTurnBody = body
      return response({ content: 'partial batch handled' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 坏的那条被拒，好的那条照常执行 —— 坏参数不能连累兄弟调用。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/b.ts' },
      expect.any(Number),
    )
    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    expect(toolResultFor(secondTurnBody!, 'sib-bad')).toContain('不是合法 JSON')
    expect(toolResultFor(secondTurnBody!, 'sib-good')).toContain('good-file-body')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'partial batch handled' })
    delegateRuntime.dispose?.()
  })

  it('still treats empty arguments as a valid no-arg call', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'listed' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 空 arguments 是无参工具的合法形态，不是解析失败 —— 不能被新分支误伤。
        return rawArgsToolCall('empty-args', 'read_file', '   ')
      }
      secondTurnBody = body
      return response({ content: 'no-arg call executed' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'list' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(runChildTool).toHaveBeenCalledWith('read_file', {}, expect.any(Number))
    expect(secondTurnBody).toBeDefined()
    expect(toolResultFor(secondTurnBody!, 'empty-args')).not.toContain('不是合法 JSON')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'no-arg call executed' })
    delegateRuntime.dispose?.()
  })

  // ---------------------------------------------------------------------------
  // finish_reason 异常三态（子 agent 循环）
  // ---------------------------------------------------------------------------
  // 回归背景：子循环从头到尾没读过 finish_reason，于是 toolCalls.length === 0 的收尾路径会把
  // 【被截断的半截 content】原样写进 result.md 并把节点标成 'done' —— 一个残缺答案以「成功」
  // 身份回填给父 agent，还会经 distill 传给后代，父/兄弟 agent 都无从知道它是半截的。
  // content_filter / insufficient_system_resource 时 content 为空，落到兜底文案后同样标 'done'。
  it('fails a child whose final answer was truncated by finish_reason=length instead of marking it done', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'file-body' } }))
    let truncatedTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-ok', 'read_file', { path: 'src/a.ts' })
      }
      truncatedTurnBody = body
      // 模型开始写结论就被掐断：content 是半截文本，finish_reason='length'。
      return finishedResponse({ content: '结论：该模块可以安全删除，因为它的唯一调用点在' }, 'length')
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const writes = new Map<string, string>()
    callContext.writeTextFile = async (input) => {
      writes.set(input.path, input.mode === 'append' ? `${writes.get(input.path) ?? ''}${input.content}` : input.content)
      return { ok: true }
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )

    const child = result.children[0]
    // 核心断言：残缺产出【不能】以 'done' 身份回填。
    expect(child.status).not.toBe('done')
    expect(child.status).toBe('failed')
    // 父 agent 能明确看到「不完整」以及精确成因。
    expect(child.error).toContain('finish_reason=length')
    expect(child.error).toContain('产出不完整')
    expect(child.summary).toBe(child.error)
    // 半截文本只作为定位线索出现，且被明确标注成不完整。
    expect(child.error).toContain('截断片段（仅供定位，不完整）')
    expect(child.error).toContain('结论：该模块可以安全删除')
    // 没有 result.md 被当成有效产出登记 —— resultFile 必须为空，且不得写出正式的 result.md。
    expect(child.resultFile).toBeUndefined()
    const resultWrites = [...writes.keys()].filter((path) => path.includes('/results/'))
    expect(resultWrites.some((path) => /result\.md$/.test(path))).toBe(false)
    // 但完整残稿【要留住】：只在最后一句被掐断的几千字产出仍然有效，父 agent 应能复用而不是整体重跑。
    // 它落在 result.partial.md（而非 result.md），状态仍是 failed —— 采信与否由父 agent 显式决定。
    const partialWrites = resultWrites.filter((path) => /result\.partial\.md$/.test(path))
    expect(partialWrites).toHaveLength(1)
    expect(writes.get(partialWrites[0])).toContain('结论：该模块可以安全删除')
    expect(child.error).toContain('完整残稿已存至')
    // 树节点同样是 failed，不是 done。
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    // parallel_wait_all 下整批判失败，父 agent 不会拿着半截结论继续往下走。
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ total: 1, done: 0, failed: 1 })
    // 上一轮【已完成】的 tool 结果回填不受影响：截断发生在下一轮，消息序列始终合法。
    expect(truncatedTurnBody).toBeDefined()
    expect(orphanToolCallIds(truncatedTurnBody!)).toEqual([])
    expect(toolResultFor(truncatedTurnBody!, 'read-ok')).toContain('file-body')
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    delegateRuntime.dispose?.()
  })

  it('fails a child whose output was blocked by finish_reason=content_filter', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      // 被安全策略拦截：content 为空。旧实现会落到 '子 agent 未返回有效文本。' 兜底并标 'done'。
      return finishedResponse({ content: '' }, 'content_filter')
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'summarize' }] },
      context(writes),
    )

    const child = result.children[0]
    expect(child.status).not.toBe('done')
    expect(child.status).toBe('failed')
    expect(child.error).toContain('finish_reason=content_filter')
    expect(child.error).toContain('内容安全策略拦截')
    // 不能再伪装成「跑完了但没话说」。
    expect(child.summary).not.toContain('子 agent 未返回有效文本')
    expect(child.resultFile).toBeUndefined()
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    // 归档事件里也记的是 failed，replay 出来的树不会有假成功。
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const finished = eventsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; agentPath: string; data?: Record<string, unknown> })
      .find((event) => event.type === 'child_finished' && event.agentPath === 'root-01')
    expect(finished?.data?.status).toBe('failed')
    expect(String(finished?.data?.error)).toContain('finish_reason=content_filter')
    delegateRuntime.dispose?.()
  })

  it('fails a child when the model reports insufficient_system_resource', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      return finishedResponse({ content: '' }, 'insufficient_system_resource')
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      // best_effort：容量不足的子 agent 应当把整批降级成 partial 语义，而不是假装成功。
      { children: [{ objective: 'a' }, { objective: 'b' }], strategy: 'parallel_best_effort' },
      context(new Map()),
    )

    expect(result.children.map((child) => child.status)).toEqual(['failed', 'failed'])
    expect(result.children[0].error).toContain('finish_reason=insufficient_system_resource')
    expect(result.children[0].error).toContain('容量不足')
    expect(result.children[0].error).toContain('稍后重试')
    // 三态文案各不相同：父 agent 据此选择重试而不是改写任务。
    expect(result.children[0].error).not.toContain('finish_reason=length')
    expect(result.children[0].error).not.toContain('content_filter')
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ total: 2, done: 0, failed: 2 })
    delegateRuntime.dispose?.()
  })

  it('keeps the truncated-arguments gate working when finish_reason=length arrives with tool calls', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'good-body' } }))
    let thirdTurnBody: Record<string, unknown> | undefined
    let turn = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      turn += 1
      if (turn === 1) {
        // 触顶【且】带 tool_calls：不能在这里终止整个子 agent，否则上一轮补的坏 JSON 闸门就废了。
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'cut-args', type: 'function', function: { name: 'read_file', arguments: '{"path": "src/a' } },
                  ],
                },
                finish_reason: 'length',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (turn === 2) return namedToolCall('retry-ok', 'read_file', { path: 'src/a.ts' })
      thirdTurnBody = body
      return response({ content: 'recovered and answered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 半截 arguments 没被执行，但循环没被 finish_reason 分流掐死 —— 子 agent 重发后恢复。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    expect(thirdTurnBody).toBeDefined()
    expect(orphanToolCallIds(thirdTurnBody!)).toEqual([])
    expect(toolResultFor(thirdTurnBody!, 'cut-args')).toContain('不是合法 JSON')
    expect(toolResultFor(thirdTurnBody!, 'retry-ok')).toContain('good-body')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered and answered' })
    delegateRuntime.dispose?.()
  })

  it('marks a distilled skill as incomplete when the distillation itself was truncated', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      // 蒸馏调用本身触顶：skill 正文会被子孙 agent 继承，截断信息不能在这条链路上丢失。
      if (body.tool_choice === 'none') return finishedResponse({ content: '# 半截 brief' }, 'length')
      return response({ content: 'child answered' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'work' }] },
      context(writes),
    )

    // 不 throw：整批不因为一次蒸馏截断而失败。
    expect(result.children[0].status).toBe('done')
    const skillWrite = [...writes.entries()].find(([path]) => path.includes('/skills/'))?.[1] ?? ''
    expect(skillWrite).toContain('# 半截 brief')
    expect(skillWrite).toContain('finish_reason=length')
    expect(skillWrite).toContain('本 skill 内容不完整')
    delegateRuntime.dispose?.()
  })

  it('summarizes an oversized tool body in the request only, keeping messages and the distilled transcript on the original text', async () => {
    // 子 agent 顶爆上下文的真实形状不是「轮数多」（HARD_MAX_TURNS=8 已经封顶），
    // 而是【单轮 payload 巨大】：read_file 把整个文件正文原样回填进 messages。
    // 没有压缩时这里换来的是一个硬 400，而不是优雅降级。
    const HUGE_HEAD = 'A'.repeat(300)
    // 标记刻意放在第 300 字符处 —— 它落在原文的前 2000 字符内（因此会出现在 distill 的
    // transcript 里），却落在摘要占位保留的「头 200 / 尾 100 字符」之外。于是同一个标记
    // 可以互斥地判定两件事：请求体确实被摘要了 ✕ 归档/继承链路上仍是原文。
    const MIDDLE_MARKER = 'ORIGINAL_UNCOMPACTED_MIDDLE'
    const hugeFileBody = `${HUGE_HEAD}${MIDDLE_MARKER}${'B'.repeat(400_000)}TAILEND`

    const distillBodies: Record<string, unknown>[] = []
    let compactedTurnBody: Record<string, unknown> | undefined
    let parentTurns = 0

    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: hugeFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') {
        distillBodies.push(body)
        return response({ content: '# skill' })
      }
      const path = childPath(body)
      if (path === 'root-01') {
        parentTurns += 1
        if (parentTurns === 1) return namedToolCall('read-huge', 'read_file', { path: 'src/huge.ts' })
        if (parentTurns === 2) {
          compactedTurnBody = body
          // 第 2 轮顺手发起一次嵌套 delegate：runChildAgent 会把
          // formatSubagentTranscript(messages) 当作 parentTranscript 喂给 distill，
          // 而那份 brief 会被后代继承。它是「压缩污染了 messages」最致命的观测点。
          return toolCall('nested-1', { children: [{ objective: 'nested' }] })
        }
        return response({ content: 'parent done' })
      }
      return response({ content: 'nested done' })
    }

    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read', maxDepth: 2 },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'parent done' })

    // ① 请求体：超预算的历史 tool 正文被摘要成占位，原文中段标记消失。
    expect(compactedTurnBody).toBeDefined()
    const compactedToolResult = toolResultFor(compactedTurnBody!, 'read-huge')
    expect(compactedToolResult).toContain('_compacted')
    expect(compactedToolResult).not.toContain(MIDDLE_MARKER)
    expect(compactedToolResult.length).toBeLessThan(2_000)
    // 摘要不是「丢掉」：工具名与头尾线索仍在，模型知道该重调哪个工具。
    expect(compactedToolResult).toContain('read_file')

    // ② tool-call 配对完整：摘要只改 content、不改变条目存在性，一条都不会丢，
    //    所以 assistant.tool_calls ↔ tool_call_id 不可能出孤儿。
    expect(orphanToolCallIds(compactedTurnBody!)).toEqual([])
    expect(messagesOf(compactedTurnBody!).map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])

    // ③ messages / 归档侧：喂进 distill 的 parent transcript 仍是【原文】。
    //    一旦压缩结果被写回 messages，这里就会变成摘要占位 —— 后代继承到失真的 brief，
    //    子 agent 后续轮次也会基于被摘要的历史继续推理。
    const distillText = distillBodies.map((body) => JSON.stringify(body.messages)).join('\n')
    expect(distillText).toContain(MIDDLE_MARKER)
    expect(distillText).not.toContain('_compacted')

    delegateRuntime.dispose?.()
  })

  it('leaves a within-budget subagent request untouched', async () => {
    // 压缩只在真的超预算时才动手：正常子任务的工具正文必须逐字原样重发，
    // 否则模型每轮都在读被裁过的历史，等于凭空制造幻觉源。
    // ★ 正文长度必须【足以被摘要】（> 摘要占位保留的头 200 + 尾 100 字符），否则本用例是假绿的：
    //   短于该门槛的正文 summarizeToolResultContent 一律返回 undefined，无论预算多小都压不动，
    //   于是「预算被调坏」这件事根本不会让测试变红。5000 字符 ≈ 1250 token，远在预算内，
    //   但只要压缩逻辑真的被触发就一定会被摘掉。
    const smallFileBody = `SMALL_BODY_HEAD${'s'.repeat(5_000)}`
    let secondTurnBody: Record<string, unknown> | undefined
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: smallFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-small', 'read_file', { path: 'src/a.ts' })
      }
      secondTurnBody = body
      return response({ content: 'done' })
    }

    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    expect(secondTurnBody).toBeDefined()
    // 逐字相等 —— 不是 toContain，摘要哪怕只截掉一个字符都要红。
    expect(toolResultFor(secondTurnBody!, 'read-small')).toBe(JSON.stringify({ content: smallFileBody }))
    expect(JSON.stringify(secondTurnBody!.messages)).not.toContain('_compacted')
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    delegateRuntime.dispose?.()
  })

  // 一个「第 2 轮会被压缩」的最小子 agent 场景：第 1 轮读一个巨大文件，第 2 轮的 messages
  // 因此撑爆预算。压缩的可观测性用例全部复用它。
  function compactingChildFetch() {
    const hugeFileBody = `HEAD${'B'.repeat(400_000)}TAIL`
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: hugeFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-huge', 'read_file', { path: 'src/huge.ts' })
      }
      return response({ content: 'done' })
    }
    return { fetchImpl, runChildTool }
  }

  it('records a context-compaction archive event for the subagent turn that was compacted', async () => {
    // 压缩本身是「悄悄降级」。没有这条事件，父 agent / 树面板 / trace / 归档没有任何一处能看出
    // 子 agent 的上下文被压过 —— 排查者只会怀疑模型变笨了。
    const { fetchImpl, runChildTool } = compactingChildFetch()
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })

    const compacted = eventsTyped(writes, 'child_context_compacted')
    expect(compacted).toHaveLength(1)
    expect(compacted[0].agentPath).toBe('root-01')
    const data = compacted[0].data ?? {}
    // 第 1 轮（只有 [system, user]）远在预算内，不该记事件 —— 记了就是刷屏。
    expect(data.turn).toBe(2)
    expect(data.summarizedToolResults).toBe(1)
    // L4 只摘要正文、不丢条目。droppedItems=0 + 前后条数相等，是「不可能产生孤儿 tool_call」
    // 这条协议保证的数值化断言。
    expect(data.droppedItems).toBe(0)
    expect(data.messagesBefore).toBe(4)
    expect(data.messagesAfter).toBe(4)
    // 压缩前超预算、压缩后达标 —— 三个数字互相咬合，任何一个取错源都会红。
    expect(data.estBeforeTk as number).toBeGreaterThan(data.effectiveBudgetTk as number)
    expect(data.estAfterTk as number).toBeLessThanOrEqual(data.effectiveBudgetTk as number)
    expect(data.estAfterTk as number).toBeLessThan(data.estBeforeTk as number)
    expect(data.reservedTk as number).toBeGreaterThan(0)
    expect(data.withinBudget).toBe(true)

    // 压到达标之后就【不】该再报 over_budget：两条事件不是同义反复。
    expect(eventsTyped(writes, 'child_context_over_budget')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })

  it('records no compaction event when every subagent turn stays within budget', async () => {
    // 正常子任务占绝大多数。这两类事件一旦在未压缩时也发，事件日志立刻被淹没，
    // 「这个子 agent 被压过」这个信号就等于没有。
    // ★ 正文必须长到【足以被摘要】（> 头 200 + 尾 100 字符），否则本用例假绿：
    //   短正文无论预算多小都压不动，把预算改坏也不会让它变红。
    const smallFileBody = `SMALL${'s'.repeat(5_000)}`
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: smallFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-small', 'read_file', { path: 'src/a.ts' })
      }
      return response({ content: 'done' })
    }
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    // 事件日志本身非空（说明确实在记事件，不是路径找错了导致的空数组假绿）。
    expect(eventsOf(writes).length).toBeGreaterThan(0)
    expect(eventsTyped(writes, 'child_context_compacted')).toHaveLength(0)
    expect(eventsTyped(writes, 'child_context_over_budget')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })

  it('records a standalone over-budget event when the context cannot be compacted at all', async () => {
    // withinBudget=false 的最纯形态：messages 只有 [system, user]，两条都在 compactContext 的
    // 硬保护范围内 —— 压缩跑了但一点忙都帮不上（compacted=false）。请求照发，大概率换来一个硬
    // 400，而那个 400 与「压缩根本没生效」在日志里长得一模一样。
    // ★ 所以 over_budget 必须是【独立于 compacted 的判断】★：挂进 `if (compacted)` 里面，
    //   恰好会漏掉这个最该报警的形态。
    const hugeObjective = `analyze ${'x'.repeat(400_000)}`
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: hugeObjective }] },
      context(writes),
    )

    // 超预算不中止子 agent —— 序列仍然合法，照发不误，只是留痕。
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })

    expect(eventsTyped(writes, 'child_context_compacted')).toHaveLength(0)
    const overBudget = eventsTyped(writes, 'child_context_over_budget')
    // 两条：子 agent 那一轮，加上蒸馏那次调用 —— 后者的 user 正文含整份 parentTranscript，
    // 深树 + 长对话下它自己就能超预算，而 [system,user] 都在硬保护范围内、压不动。
    // 两者【必须可区分】：超预算的成因和补救方式不同，一个是「子 agent 干太多活」，
    // 一个是「父 agent 的 transcript / 继承 skill 太长」，混在一起排查者不知道该缩哪一头。
    expect(overBudget).toHaveLength(2)

    const childEvent = overBudget.find((e) => e.data?.phase === 'subagent')
    const distillEvent = overBudget.find((e) =>
      String(e.data?.phase).startsWith('distill:'))
    expect(childEvent).toBeDefined()
    expect(distillEvent).toBeDefined()

    expect(childEvent!.agentPath).toBe('root-01')
    const data = childEvent!.data ?? {}
    expect(data.turn).toBe(1)
    expect(data.compacted).toBe(false)
    expect(data.estAfterTk as number).toBeGreaterThan(data.effectiveBudgetTk as number)
    expect(String(data.hint)).toContain('无可压缩内容')

    // 这里超预算的是给该子 agent 生成的 child brief，所以事件归到实际消费它的子路径；
    // turn=0（蒸馏不是「轮」，靠 phase 标识）。
    expect(distillEvent!.agentPath).toBe('root-01')
    expect(distillEvent!.data?.phase).toBe('distill:child_brief')
    expect(distillEvent!.data?.turn).toBe(0)
    delegateRuntime.dispose?.()
  })

  it('keeps the subagent finishing normally when the compaction event write fails', async () => {
    // 可观测性代码永远不该有能力让被观测的东西失败。这正是 bestEffortRecordEvent 与
    // recordEvent 的唯一差别：后者会把写盘异常抛给 callModel，一路冒到 runChildAgent 的 catch，
    // 于是「记日志失败」伪装成「子 agent 失败」回填给父 agent。
    const { fetchImpl, runChildTool } = compactingChildFetch()
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const passthrough = callContext.writeTextFile!
    const rejected: string[] = []
    callContext.writeTextFile = async (input) => {
      // 只掐压缩事件那一次写，其余归档写照常 —— 否则失败原因会混进别的链路，测不准。
      if (input.content.includes('"child_context_compacted"')) {
        rejected.push(input.path)
        throw new Error('archive host is gone')
      }
      return passthrough(input)
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 确实走到了那条写（否则下面的「仍然 done」是空断言）。
    expect(rejected).toHaveLength(1)
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    // 事件没落盘，但子 agent 的产出与状态完好。
    expect(eventsTyped(writes, 'child_context_compacted')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })
})

describe('createDelegateAgentRuntime · 主 Agent 模型归一化（发请求前）', () => {
  it('父会话带 deepseek-reasoner → 默认子 agent 请求体用 v4-pro 且 thinking enabled', async () => {
    // 子 agent 复用父会话 settings。父会话若带着已下线的模型名，扇出的每个子 agent 都会撞 400。
    // createDelegateAgentRuntime 在入口整体迁移并收口主模型；未显式选择 Flash 的子任务默认使用 Pro。
    let childBody: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      childBody = body
      return response({ content: 'done' })
    }
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-mig',
      settings: { vendor: 'deepseek', model: 'deepseek-reasoner' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'go' }], toolProfile: 'workspace_read' },
      context(new Map()),
    )
    expect(result.children[0].status).toBe('done')
    expect(childBody.model).toBe('deepseek-v4-pro')
    expect(childBody.thinking).toEqual({ type: 'enabled' })
    delegateRuntime.dispose?.()
  })
})

describe('createDelegateAgentRuntime · runLowCostExtraction', () => {
  // 回归护栏：曾经给内部 callModel 传死 maxModelCalls=1，而那个参数是「树累计上限」而非
  // 「本次花几次」。于是只要本 run 里跑过任何子 agent（含上一个 stage 的 evaluator），
  // modelCallsUsed 就已 ≥ 1，这里必抛 budget exhausted —— 调用方 best-effort 吞掉异常，
  // 能力从第二个 stage 起静默失效，且因为工具侧全 mock，测试还全绿。
  it('子 agent 跑过之后仍然可用，并且可以连续调用', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' && body.model === 'deepseek-v4-flash'
        ? response({ role: 'assistant', content: '{"commands":[],"warnings":[]}' })
        : response({ role: 'assistant', content: 'done' })
    }
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'inspect one bounded item' }] },
      context(new Map()),
    )
    const first = await delegateRuntime.runLowCostExtraction!({ systemPrompt: 'sys', userPrompt: 'user' })
    const second = await delegateRuntime.runLowCostExtraction!({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(first.model).toBe('deepseek-v4-flash')
    expect(second.model).toBe('deepseek-v4-flash')
    delegateRuntime.dispose?.()
  })

  it('走的是 flash 档、无工具、temperature 0、thinking 关闭', async () => {
    let extractionBody: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      extractionBody = requestBody(init)
      return response({ role: 'assistant', content: '{}' })
    }
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.runLowCostExtraction!({
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxOutputTokens: 1_200,
    })

    expect(extractionBody.model).toBe('deepseek-v4-flash')
    expect(extractionBody.temperature).toBe(0)
    expect(extractionBody.thinking).toEqual({ type: 'disabled' })
    expect(extractionBody.tool_choice).toBe('none')
    expect(messagesOf(extractionBody).map((message) => message.role)).toEqual(['system', 'user'])
    delegateRuntime.dispose?.()
  })

  // 供应商支持与否在构造时就确定，故做成「方法在不在」而不是「调用时抛」：
  // 后者会让宿主的能力探测恒真，把永久性不可用伪装成可重试的运行时失败。
  it('非 DeepSeek 双档模型时，整个方法不挂载', async () => {
    const fetchImpl: typeof fetch = async () => response({ role: 'assistant', content: 'done' })
    const glm = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-glm',
      settings: { vendor: 'glm', model: 'glm-4.6' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    expect(glm.runLowCostExtraction).toBeUndefined()
    glm.dispose?.()
  })
})
