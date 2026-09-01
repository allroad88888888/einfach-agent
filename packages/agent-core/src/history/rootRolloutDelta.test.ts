import type { ModelItem } from '@einfach-agent/ai'
import { describe, expect, it } from 'vitest'

import { RECOVERY_SNAPSHOT_COMMIT_MARKER, RECOVERY_SNAPSHOT_SCHEMA_VERSION, type RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import { buildRootRolloutDelta } from './rootRolloutDelta'

function snapshot(items: RecoverySnapshotV1['values']['conversation']['items'] = []): RecoverySnapshotV1 {
  return {
    schemaVersion: RECOVERY_SNAPSHOT_SCHEMA_VERSION,
    sessionId: '会话-1',
    capturedAt: 1,
    generation: 1,
    commitMarker: RECOVERY_SNAPSHOT_COMMIT_MARKER,
    session: { id: '会话-1', title: '标题', settings: { vendor: 'test', model: 'model' }, createdAt: 1, updatedAt: 1 },
    values: {
      conversation: { items, contextCheckpoint: null },
      plan: { current: null, stageCheckpoints: [] },
      run: { runId: 'run-1', status: 'done', turnId: 'user-1' },
      queuedUserMessages: [], pendingQuestionAnswers: {}, pendingArtifacts: [],
      executionGraph: { version: 1, nodes: {}, order: [] }, subagentContinuations: [],
    },
  }
}

function item(id: string, content: ModelItem, pending?: boolean, planStageId?: string) {
  return { id, createdAt: 10, item: content, pending, planStageId }
}

describe('buildRootRolloutDelta', () => {
  it('backfills a first capture in deterministic meta, context, item, run order', () => {
    const current = snapshot([
      item('user-1', { role: 'user', content: '你好 🌍' }, undefined, 'stage-1'),
      item('assistant-1', { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: '搜索', arguments: '{"城市":"上海"}' } }] }, true),
    ])

    expect(buildRootRolloutDelta(undefined, current)).toMatchObject([
      { mutationType: 'session_meta' },
      { mutationType: 'turn_context', itemIds: ['user-1', 'assistant-1'] },
      { mutationType: 'item_upsert', itemId: 'user-1', itemOrdinal: 0, pending: false, planStageId: 'stage-1' },
      { mutationType: 'item_upsert', itemId: 'assistant-1', itemOrdinal: 1, pending: true, planStageId: null },
      { mutationType: 'run_state', status: 'done' },
    ])
    expect(current.values.conversation.items[0]?.pending).toBeUndefined()
  })

  it('returns no mutations for an equivalent capture regardless of object key order', () => {
    const previous = snapshot([item('assistant-1', { role: 'assistant', content: 'ok', reasoning_content: '思考' })])
    const current = structuredClone(previous)
    current.values.conversation.items[0]!.item = { reasoning_content: '思考', content: 'ok', role: 'assistant' }

    expect(buildRootRolloutDelta(previous, current)).toEqual([])
  })

  it('rejects delta construction across different sessions before producing mutations', () => {
    const previous = snapshot([item('old-item', { role: 'user', content: 'old session' })])
    const current = snapshot([item('new-item', { role: 'user', content: 'new session' })])
    current.sessionId = '会话-2'
    current.session.id = '会话-2'

    expect(() => buildRootRolloutDelta(previous, current)).toThrow('Cannot build a root rollout delta across sessions')
  })

  it('writes only an appended item and its changed context', () => {
    const previous = snapshot([item('user-1', { role: 'user', content: 'first' })])
    const current = snapshot([...previous.values.conversation.items, item('tool-1', { role: 'tool', tool_call_id: 'call-1', content: '结果' })])

    expect(buildRootRolloutDelta(previous, current)).toMatchObject([
      { mutationType: 'turn_context', itemIds: ['user-1', 'tool-1'] },
      { mutationType: 'item_upsert', itemId: 'tool-1', itemOrdinal: 1 },
    ])
  })

  it('writes an upsert when an item changes', () => {
    const previous = snapshot([item('assistant-1', { role: 'assistant', content: 'draft' }, true)])
    const current = snapshot([item('assistant-1', { role: 'assistant', content: 'final' }, true)])

    expect(buildRootRolloutDelta(previous, current)).toEqual([
      expect.objectContaining({ mutationType: 'item_upsert', itemId: 'assistant-1', item: { role: 'assistant', content: 'final' } }),
    ])
  })

  it('writes an upsert when pending finalizes', () => {
    const previous = snapshot([item('assistant-1', { role: 'assistant', content: 'final' }, true, 'stage-1')])
    const current = snapshot([item('assistant-1', { role: 'assistant', content: 'final' }, false, 'stage-1')])

    expect(buildRootRolloutDelta(previous, current)).toEqual([
      expect.objectContaining({ mutationType: 'item_upsert', itemId: 'assistant-1', pending: false, planStageId: 'stage-1' }),
    ])
  })

  it('writes an upsert when only the plan stage changes', () => {
    const previous = snapshot([item('assistant-1', { role: 'assistant', content: 'final' }, false, 'stage-1')])
    const current = snapshot([item('assistant-1', { role: 'assistant', content: 'final' }, false, 'stage-2')])

    expect(buildRootRolloutDelta(previous, current)).toEqual([
      expect.objectContaining({ mutationType: 'item_upsert', itemId: 'assistant-1', pending: false, planStageId: 'stage-2' }),
    ])
  })

  it('rewrites every item whose ordinal changes during a reorder', () => {
    const first = item('first', { role: 'user', content: 'first' })
    const second = item('second', { role: 'user', content: 'second' })
    const previous = snapshot([first, second])
    const current = snapshot([second, first])

    expect(buildRootRolloutDelta(previous, current)).toMatchObject([
      { mutationType: 'turn_context', itemIds: ['second', 'first'] },
      { mutationType: 'item_upsert', itemId: 'second', itemOrdinal: 0 },
      { mutationType: 'item_upsert', itemId: 'first', itemOrdinal: 1 },
    ])
  })

  it('emits tombstones for deleted items before the run state', () => {
    const previous = snapshot([item('removed', { role: 'user', content: 'remove me' })])
    const current = snapshot()
    current.values.run = { runId: 'run-2', status: 'error', error: 'failed' }

    expect(buildRootRolloutDelta(previous, current)).toMatchObject([
      { mutationType: 'turn_context', turnId: null, itemIds: [] },
      { mutationType: 'item_deleted', itemId: 'removed', reason: 'deleted' },
      { mutationType: 'run_state', runId: 'run-2', status: 'error', error: 'failed' },
    ])
  })
})
