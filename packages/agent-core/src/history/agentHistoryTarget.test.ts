import { describe, expect, it } from 'vitest'

import { decodeAgentRolloutRecord } from './rolloutRecordCodec'

describe('AgentHistoryTarget codec', () => {
  it('requires all child identity fields', () => {
    expect(() => decodeAgentRolloutRecord(JSON.stringify({
      schemaVersion: 1,
      historyId: 'history-1',
      rolloutOrdinal: 0,
      recordedAt: '2026-09-01T00:00:00.000Z',
      mutationType: 'item_deleted',
      target: { kind: 'child', conversationId: 'conversation-1', runId: 'run-1' },
      itemId: 'item-1',
      reason: 'removed',
    }))).toThrow(/agentPath/)
  })
})
