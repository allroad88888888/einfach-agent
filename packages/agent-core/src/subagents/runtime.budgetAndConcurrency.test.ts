import { describe, expect, it, vi } from 'vitest'
import type { SubagentNodeRecord } from './types'
import {
  childPath,
  context,
  messagesOf,
  namedToolCall,
  requestBody,
  response,
  runtime,
  toolCall,
} from './runtime.testHarness'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'

describe('createDelegationRuntime · 预算与并发', () => {
  it('isolates authorization and tool profiles across concurrent root delegations', async () => {
    let activeRootBChildren = 0
    let peakRootBChildren = 0
    const childRequests: Array<{ root: 'a' | 'b'; body: Record<string, unknown> }> = []
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { ok: true } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      const root = messages.some((message) => message.content?.includes('root A writes')) ? 'a' : 'b'
      childRequests.push({ root, body })
      if (root === 'b') {
        activeRootBChildren += 1
        peakRootBChildren = Math.max(peakRootBChildren, activeRootBChildren)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeRootBChildren -= 1
      }
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall(`${root}-write`, 'write_file', { path: `${root}.txt`, content: root })
      }
      return response({ content: `${root} done` })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: 'run-root-isolation',
      settings: { vendor: 'deepseek', model: 'test-model' },
      hostHasLocalCapabilities: true,
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    const rootAContext = context(writes)
    rootAContext.runChildTool = runChildTool
    rootAContext.delegationCallId = 'root-a'
    rootAContext.dangerousToolCapability = {
      sessionId: 'session',
      runId: 'run-root-isolation',
      delegationCallId: 'root-a',
      parentPath: 'root',
      toolNames: ['write_file'],
    }
    const rootBContext = context(writes)
    rootBContext.runChildTool = runChildTool
    rootBContext.delegationCallId = 'root-b'

    const [rootA, rootB] = await Promise.all([
      delegateRuntime.delegateAgents({
        children: [{ objective: 'root A writes' }],
        maxConcurrent: 1,
        toolProfile: 'workspace_read',
        confirmedTools: ['write_file'],
      }, rootAContext),
      delegateRuntime.delegateAgents({
        children: [{ objective: 'root B one' }, { objective: 'root B two' }],
        maxConcurrent: 2,
        toolProfile: 'delegate_only',
      }, rootBContext),
    ])

    expect(rootA.children.every((child) => child.status === 'done')).toBe(true)
    expect(rootB.children.every((child) => child.status === 'done')).toBe(true)
    expect(peakRootBChildren).toBe(2)
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith(
      'write_file',
      { path: 'a.txt', content: 'a' },
      expect.any(Number),
    )
    const toolNamesFor = (root: 'a' | 'b') => childRequests
      .filter((request) => request.root === root)
      .flatMap((request) => (request.body.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ))
    expect(toolNamesFor('a')).toEqual(expect.arrayContaining(['read_file', 'write_file']))
    expect(toolNamesFor('b')).not.toContain('read_file')
    expect(toolNamesFor('b')).not.toContain('write_file')
    await delegateRuntime.dispose?.()
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
    ).rejects.toThrow('Chat completion transport failed (network_error).')

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

})
