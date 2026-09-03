import type { ModelItem } from '@einfach-agent/ai'
import { describe, expect, it } from 'vitest'

import {
  AGENT_ROLLOUT_MAX_LINE_BYTES,
  decodeAgentRolloutRecord,
  encodeAgentRolloutRecord,
} from './rolloutRecordCodec'
import type { AgentRolloutMutationV1, AgentRolloutRecordV1 } from './rolloutMutation'

const target = { kind: 'root', conversationId: '会话-一' } as const
const item: ModelItem = {
  role: 'assistant',
  content: '你好 🌍',
  reasoning_content: '保留原始 Unicode',
  tool_calls: [{ id: 'call-1', type: 'function', function: { name: '查询', arguments: '{"城市":"上海"}' } }],
}

const mutations: readonly AgentRolloutMutationV1[] = [
  { mutationType: 'session_meta', target, title: '标题', createdAt: 1, updatedAt: 2 },
  { mutationType: 'turn_context', target, turnId: 'turn-1', itemIds: ['item-1'] },
  {
    mutationType: 'item_upsert',
    target,
    itemId: 'item-1',
    itemOrdinal: 0,
    createdAt: 3,
    item,
    pending: true,
    planStageId: 'stage-一',
  },
  { mutationType: 'item_deleted', target, itemId: 'item-0', reason: 'replaced' },
  { mutationType: 'run_state', target, runId: 'run-1', turnId: 'turn-1', status: 'done', error: null },
]

function record(mutation: AgentRolloutMutationV1, ordinal = 0): AgentRolloutRecordV1 {
  return { ...mutation, schemaVersion: 1, historyId: 'history-1', rolloutOrdinal: ordinal, recordedAt: '2026-09-01T00:00:00.000Z' }
}

describe('rollout record codec', () => {
  it('round-trips all mutation variants and preserves ModelItem data', () => {
    for (const [index, value] of mutations.entries()) {
      const original = record(value, index)
      expect(decodeAgentRolloutRecord(encodeAgentRolloutRecord(original))).toEqual(original)
    }
  })

  it('preserves rollout string bounds independently from query target schemas', () => {
    const longTarget = { kind: 'root', conversationId: 'x'.repeat(1_001) } as const
    const value = record({ mutationType: 'session_meta', target: longTarget,
      title: 'long target', createdAt: 1, updatedAt: 1 })
    expect(decodeAgentRolloutRecord(encodeAgentRolloutRecord(value)).target).toEqual(longTarget)
  })

  it.each([
    ['unknown schema', { ...record(mutations[0]!), schemaVersion: 2 }, /schemaVersion/],
    ['negative ordinal', { ...record(mutations[0]!), rolloutOrdinal: -1 }, /rolloutOrdinal/],
    ['invalid timestamp', { ...record(mutations[0]!), recordedAt: 'yesterday' }, /recordedAt/],
  ])('rejects %s', (_name, value, diagnostic) => {
    expect(() => decodeAgentRolloutRecord(JSON.stringify(value))).toThrow(diagnostic)
  })

  it('rejects oversized lines before parsing', () => {
    expect(() => decodeAgentRolloutRecord(' '.repeat(AGENT_ROLLOUT_MAX_LINE_BYTES + 1))).toThrow(/line exceeds/)
  })

  it('rejects multiple physical lines', () => {
    expect(() => decodeAgentRolloutRecord(`${encodeAgentRolloutRecord(record(mutations[0]!))}\n`)).toThrow(/one physical line/)
  })

  it('rejects unbounded nested ModelItem objects', () => {
    let content: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) content = { nested: content }
    const invalid = record({
      mutationType: 'item_upsert',
      target,
      itemId: 'item-1',
      itemOrdinal: 0,
      createdAt: 1,
      item: content as unknown as ModelItem,
      pending: false,
      planStageId: null,
    })
    expect(() => encodeAgentRolloutRecord(invalid)).toThrow(/maximum depth/)
  })

  it.each(['pending', 'planStageId'] as const)('requires item_upsert.%s', (field) => {
    const value = { ...record(mutations[2]!) } as Record<string, unknown>
    delete value[field]
    expect(() => decodeAgentRolloutRecord(JSON.stringify(value))).toThrow(new RegExp(`\\.${field}.*required`))
  })

  it.each([
    ['pending', 'false', /\.pending.*boolean/],
    ['planStageId', false, /\.planStageId.*non-empty string/],
  ])('rejects invalid item_upsert.%s', (field, invalidValue, diagnostic) => {
    expect(() => decodeAgentRolloutRecord(JSON.stringify({
      ...record(mutations[2]!),
      [field]: invalidValue,
    }))).toThrow(diagnostic)
  })
})
