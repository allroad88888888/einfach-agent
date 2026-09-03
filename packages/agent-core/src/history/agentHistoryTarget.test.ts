import { describe, expect, it } from 'vitest'

import {
  agentHistoryTargetIdentity,
  agentHistoryTargetJsonSchema,
  agentHistoryTargetKey,
  decodeAgentHistoryTarget,
  decodeAgentHistoryTargetIdentity,
  sameAgentHistoryTarget,
} from './agentHistoryTarget'
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

  it('decodes exact root and child shapes while rejecting additions', () => {
    const root = { kind: 'root', conversationId: 'conversation-1' } as const
    const child = { kind: 'child', conversationId: 'conversation-1',
      runId: 'run-1', agentPath: '/root/research' } as const
    expect(decodeAgentHistoryTarget(root)).toEqual(root)
    expect(decodeAgentHistoryTarget(child)).toEqual(child)
    expect(() => decodeAgentHistoryTarget({ ...root, runId: 'forbidden' })).toThrow(/runId.*not allowed/)
    expect(() => decodeAgentHistoryTarget({ ...child, runId: '' })).toThrow(/runId.*non-empty/)
  })

  it('keeps envelope-specific string bounds outside the shared shape decoder', () => {
    const target = { kind: 'root', conversationId: 'x'.repeat(1_001) } as const
    expect(decodeAgentHistoryTarget(target)).toEqual(target)
    expect(() => decodeAgentHistoryTarget(target, (value, field) => {
      if (typeof value !== 'string' || value.length > 1_000) throw new RangeError(`${field} too long`)
      return value
    })).toThrow(/conversationId too long/)
  })

  it('owns storage identity, collision-safe keys, and equality', () => {
    const root = { kind: 'root', conversationId: 'conversation-1' } as const
    const child = { kind: 'child', conversationId: 'a', runId: 'b\0c', agentPath: 'd' } as const
    const other = { kind: 'child', conversationId: 'a\0b', runId: 'c', agentPath: 'd' } as const
    expect(agentHistoryTargetIdentity(root)).toEqual({
      kind: 'root', conversationId: 'conversation-1', runId: null, agentPath: null,
    })
    expect(decodeAgentHistoryTargetIdentity(agentHistoryTargetIdentity(child))).toEqual(child)
    expect(agentHistoryTargetKey(child)).not.toBe(agentHistoryTargetKey(other))
    expect(sameAgentHistoryTarget(child, { ...child })).toBe(true)
    expect(sameAgentHistoryTarget(child, other)).toBe(false)
  })

  it('derives both JSON schema branches with a caller-owned string bound', () => {
    expect(agentHistoryTargetJsonSchema(7)).toEqual({ oneOf: [
      { type: 'object', additionalProperties: false,
        properties: { kind: { const: 'root' },
          conversationId: { type: 'string', minLength: 1, maxLength: 7 } },
        required: ['kind', 'conversationId'] },
      { type: 'object', additionalProperties: false,
        properties: {
          kind: { const: 'child' },
          conversationId: { type: 'string', minLength: 1, maxLength: 7 },
          runId: { type: 'string', minLength: 1, maxLength: 7 },
          agentPath: { type: 'string', minLength: 1, maxLength: 7 },
        }, required: ['kind', 'conversationId', 'runId', 'agentPath'] },
    ] })
  })
})
