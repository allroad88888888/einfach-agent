import { describe, expect, it } from 'vitest'
import { defaultCore } from '../runtime/core/coreInstance'
import { contextCheckpointAtom, itemsAtom } from '../state/sessionAtoms'
import { capabilityToolRegistry, captureRunCapabilitySnapshot } from '../runtime/turnToolVisibility'
import { createLockedEmptySessionCapabilityPolicy } from '../state/sessionCapabilityPolicy'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'
import { childPath, context, isContextDistillationRequest, namedToolCall, requestBody, response } from './runtime.testHarness'

describe('child compaction tool isolation', () => {
  it('uses the registered tool in a restricted run and leaves the parent state untouched', async () => {
    const session = defaultCore.getSessionStore('parent')
    const parentItems = [{ id: 'parent-item', createdAt: 1, item: { role: 'user' as const, content: 'parent task' } }]
    const parentSummary = { schemaVersion: 1 as const, summary: 'parent summary', coveredItemIds: ['parent-item'], createdAt: 1, sourceEstimatedTokens: 10 }
    session.store.setter(itemsAtom, parentItems)
    session.store.setter(contextCheckpointAtom, parentSummary)
    let childTurns = 0
    let summaries = 0
    const writes = new Map<string, string>()
    const policy = { ...createLockedEmptySessionCapabilityPolicy(), allowedTools: ['read_file'] }
    const registry = capabilityToolRegistry(defaultCore.tools, defaultCore.tools.snapshot(), captureRunCapabilitySnapshot(policy))
    const runtime = createTestDelegationRuntime({
      sessionId: 'parent', runId: 'isolated-child-run', core: defaultCore, registry,
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      hostHasLocalCapabilities: true, apiKey: 'test', signal: new AbortController().signal,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init)
        if (isContextDistillationRequest(body)) {
          summaries += 1
          return response({ content: '树形子 agent root-01。Child read the file and should report its findings.' })
        }
        if (!childPath(body)) return response({ content: '# skill' })
        childTurns += 1
        return childTurns === 1
          ? namedToolCall('read-child-file', 'read_file', { path: 'large.txt' })
          : response({ content: 'child done' })
      },
    })
    const callContext = context(writes)
    callContext.runChildTool = async () => ({ ok: true, data: { content: 'x'.repeat(400_000) } })
    try {
      const result = await runtime.delegateAgents({ children: [{ objective: 'inspect' }], toolProfile: 'workspace_read' }, callContext)
      expect(result.children[0]).toMatchObject({ status: 'done', summary: 'child done' })
      expect(summaries).toBe(1)
      expect([...writes.values()].join('\n')).toContain('compact_context')
      expect(session.store.getter(contextCheckpointAtom)).toBe(parentSummary)
      expect(session.store.getter(itemsAtom)).toBe(parentItems)
      // Delegation itself records execution state; compression must not write parent conversation slots.
      expect(session.history.getState().entries.flatMap((entry) => entry.ops)
        .filter((op) => op.key === 'contextCheckpoint' || op.key.startsWith('items'))).toEqual([])
    } finally {
      runtime.dispose?.()
    }
  })
})
