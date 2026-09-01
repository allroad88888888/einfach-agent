import { describe, expect, it, vi } from 'vitest'
import type { RecoverySnapshotV1 } from '@einfach-agent/core/state/persistence'

import { createLegacyRootHistoryAdapter } from './legacyRootHistory'

function snapshot(sessionId = 'session'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1, sessionId, capturedAt: 3, generation: 2, commitMarker: 'complete',
    session: { id: sessionId, title: 'Recovered', settings: { vendor: 'test', model: 'test' }, createdAt: 1, updatedAt: 3 },
    values: {
      conversation: { contextCheckpoint: null, items: [
        { id: 'user', createdAt: 1, item: { role: 'user', content: 'find 😀' } },
        { id: 'answer', createdAt: 2, item: { role: 'assistant', content: 'answer' }, pending: true },
      ] },
      plan: { current: null, stageCheckpoints: [] }, run: null,
      queuedUserMessages: [], pendingQuestionAnswers: {}, pendingArtifacts: [],
      executionGraph: { version: 1, nodes: {}, order: [] }, subagentContinuations: [],
    },
  }
}

describe('legacy root history', () => {
  it('projects the recovery facade, deduplicates canonical targets, and targeted search reads once', async () => {
    const listLatest = vi.fn(async () => [snapshot()])
    const adapter = createLegacyRootHistoryAdapter({ listLatest })
    expect((await adapter.listHistories())[0].history).toMatchObject({
      status: 'legacy', complete: false, itemCount: 2,
    })
    const search = await adapter.search('😀', { kind: 'root', conversationId: 'session' })
    expect(search.hits).toHaveLength(1)
    expect(search.warnings).toEqual([expect.objectContaining({ code: 'LEGACY_PARTIAL_HISTORY' })])
    expect(listLatest).toHaveBeenCalledTimes(2)
    expect(await adapter.readItem({ kind: 'root', conversationId: 'session' }, 'answer'))
      .toMatchObject({ pending: true, role: 'assistant' })
    expect(await adapter.listHistories([{ kind: 'root', conversationId: 'session' }])).toEqual([])
  })

  it('preserves RecoveryDriver fail-loud corruption semantics', async () => {
    const corruption = new Error('Corrupt SQLite recovery JSON')
    const adapter = createLegacyRootHistoryAdapter({ listLatest: async () => { throw corruption } })
    await expect(adapter.listHistories()).rejects.toBe(corruption)
    await expect(adapter.listItems({ kind: 'root', conversationId: 'session' })).rejects.toBe(corruption)
  })
})
