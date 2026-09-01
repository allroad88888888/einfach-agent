import { describe, expect, it, vi } from 'vitest'
import type { AgentRolloutDriver, AgentRolloutMutationV1 } from '../history'
import { createCoreInstance } from '../runtime/core/coreInstance'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'
import { childPath, context, namedToolCall, requestBody, response } from './runtime.testHarness'

describe('child runtime rollout durability', () => {
  it('records the exact two-turn model context in order and flushes the child target', async () => {
    const batches: AgentRolloutMutationV1[][] = []
    const driver: AgentRolloutDriver = {
      append: vi.fn(async (_target, mutations) => {
        batches.push([...mutations])
        return { records: [] }
      }),
      reconcile: vi.fn(async () => ({ histories: [] })),
      flush: vi.fn(async () => undefined),
    }
    const core = createCoreInstance()
    core.persistence.configure({ agentRollout: driver })
    let childTurns = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      childTurns += 1
      if (childTurns === 1) return namedToolCall('inspect-1', 'read_file', { path: 'src/a.ts' })
      return response({ role: 'assistant', content: 'final answer' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'file body' } }))
    const runtime = createTestDelegationRuntime({
      sessionId: 'conversation', runId: 'run-child', core,
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      apiKey: 'key', signal: new AbortController().signal, fetchImpl,
    })

    const result = await runtime.delegateAgents({
      children: [{ objective: 'inspect', maxTurns: 2 }], toolProfile: 'workspace_read',
    }, callContext)

    expect(result.children[0].status).toBe('done')
    const mutations = batches.flat()
    const items = mutations
      .filter((mutation) => mutation.mutationType === 'item_upsert')
      .map((mutation) => mutation.item)
    expect(items.map((item) => item.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'user', 'assistant',
    ])
    expect(items[4]).toMatchObject({ role: 'user' })
    expect(items[5]).toMatchObject({ role: 'assistant', content: 'final answer' })
    expect(mutations.filter((mutation) => mutation.mutationType === 'run_state')
      .map((mutation) => mutation.status)).toEqual(['running', 'done'])
    expect(mutations.every((mutation) => (
      mutation.target.kind === 'child'
      && mutation.target.agentPath === 'root-01'
      && mutation.target.runId === 'run-child'
    ))).toBe(true)
    expect(driver.flush).toHaveBeenCalled()
    await runtime.dispose?.()
  })

  it.each([
    { stage: 'initial', modelCalls: 0 },
    { stage: 'assistant', modelCalls: 1 },
    { stage: 'tool', modelCalls: 1 },
    { stage: 'synthesis', modelCalls: 1 },
    { stage: 'done', modelCalls: 2 },
    { stage: 'flush', modelCalls: 2 },
    { stage: 'failed_terminal', modelCalls: 1 },
  ] as const)('turns a $stage durability failure into a structured failed child', async ({
    stage, modelCalls: expectedModelCalls,
  }) => {
    const batches: AgentRolloutMutationV1[][] = []
    const stageOf = (mutations: readonly AgentRolloutMutationV1[]): string => {
      if (mutations.length > 1) return 'initial'
      const mutation = mutations[0]
      if (mutation?.mutationType === 'run_state') return mutation.status
      if (mutation?.mutationType !== 'item_upsert') return 'other'
      if (mutation.item.role === 'tool') return 'tool'
      if (mutation.item.role === 'user') return 'synthesis'
      if (mutation.item.role !== 'assistant') return 'other'
      return mutation.item.tool_calls?.length ? 'assistant' : 'final_assistant'
    }
    const driver: AgentRolloutDriver = {
      append: vi.fn(async (_target, mutations) => {
        batches.push([...mutations])
        const current = stageOf(mutations)
        if (
          current === stage
          || (stage === 'failed_terminal' && (current === 'assistant' || current === 'error'))
        ) {
          throw new Error(`${stage} unavailable`)
        }
        return { records: [] }
      }),
      reconcile: vi.fn(async () => ({ histories: [] })),
      flush: vi.fn(async () => {
        if (stage === 'flush') throw new Error('flush unavailable')
      }),
    }
    const core = createCoreInstance()
    core.persistence.configure({ agentRollout: driver })
    let modelCalls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      modelCalls += 1
      return modelCalls === 1
        ? namedToolCall('inspect-1', 'read_file', { path: 'src/a.ts' })
        : response({ content: 'final answer' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = vi.fn(async () => ({ ok: true as const, data: 'body' }))
    const runtime = createTestDelegationRuntime({
      sessionId: 'conversation', runId: 'run-failure', core,
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      apiKey: 'key', signal: new AbortController().signal, fetchImpl,
    })

    const result = await runtime.delegateAgents({
      children: [{ objective: 'inspect', maxTurns: 2 }], toolProfile: 'workspace_read',
    }, callContext)

    expect(result.children[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(stage),
    })
    expect(modelCalls).toBe(expectedModelCalls)
    expect(batches.flat().filter((mutation) => mutation.mutationType === 'run_state')
      .map((mutation) => mutation.status)).toEqual(
        stage === 'done' || stage === 'flush' ? ['running', 'done', 'error'] : ['running', 'error'],
      )
    expect(driver.flush).toHaveBeenCalled()
    await runtime.dispose?.()
  })

  it('uses each runtime node path for sibling and nested child targets', async () => {
    const targets: Array<{ agentPath: string }> = []
    const ordinals = new Map<string, number[]>()
    const driver: AgentRolloutDriver = {
      append: vi.fn(async (target, mutations) => {
        if (target.kind === 'child') targets.push(target)
        for (const mutation of mutations) {
          if (mutation.mutationType !== 'item_upsert' || target.kind !== 'child') continue
          const values = ordinals.get(target.agentPath) ?? []
          values.push(mutation.itemOrdinal)
          ordinals.set(target.agentPath, values)
        }
        return { records: [] }
      }),
      reconcile: vi.fn(async () => ({ histories: [] })),
      flush: vi.fn(async () => undefined),
    }
    const core = createCoreInstance()
    core.persistence.configure({ agentRollout: driver })
    const turns = new Map<string, number>()
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      const path = childPath(body)
      if (!path) return response({ content: '# skill' })
      const turn = (turns.get(path) ?? 0) + 1
      turns.set(path, turn)
      if (path === 'root-01' && turn === 1) {
        return namedToolCall('nested', 'delegate_agent', {
          children: [{ objective: 'nested child' }],
        })
      }
      return response({ content: `${path} done` })
    }
    const runtime = createTestDelegationRuntime({
      sessionId: 'conversation', runId: 'run-tree', core,
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      apiKey: 'key', signal: new AbortController().signal, fetchImpl,
    })

    const result = await runtime.delegateAgents({
      children: [{ objective: 'parent' }, { objective: 'sibling' }], maxDepth: 2,
    }, context(new Map()))

    expect(result.children.map((child) => child.status)).toEqual(['done', 'done'])
    expect(new Set(targets.map((target) => target.agentPath))).toEqual(
      new Set(['root-01', 'root-02', 'root-01-01']),
    )
    for (const values of ordinals.values()) {
      expect(values).toEqual(values.map((_value, index) => index))
    }
    await runtime.dispose?.()
  })
})
