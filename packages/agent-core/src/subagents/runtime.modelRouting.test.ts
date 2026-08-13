import { describe, expect, it } from 'vitest'
import {
  childPath,
  context,
  eventsTyped,
  finishedResponse,
  messagesOf,
  namedToolCall,
  requestBody,
  response,
  runtime,
  toolCall,
} from './runtime.testHarness'

describe('createDelegateAgentRuntime · 模型分级路由与重放护栏', () => {
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
})
