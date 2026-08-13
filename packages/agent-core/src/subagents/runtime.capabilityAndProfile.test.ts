import { describe, expect, it, vi } from 'vitest'
import type { SubagentNodeRecord } from './types'
import {
  childPath,
  context,
  namedToolCall,
  requestBody,
  response,
  runtime,
  toolCall,
} from './runtime.testHarness'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'

describe('createDelegationRuntime · 危险工具能力与档位继承', () => {
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
    const stableRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: 'run-capability',
      settings: { vendor: 'deepseek', model: 'test-model' },
      runtimeIsTauri: true,
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
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: 'run-change-sets',
      settings: { vendor: 'deepseek', model: 'test-model' },
      runtimeIsTauri: true,
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
    const delegateRuntime = createTestDelegationRuntime({
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
    const delegateRuntime = createTestDelegationRuntime({
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
})
