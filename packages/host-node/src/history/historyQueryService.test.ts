import { describe, expect, it, vi } from 'vitest'
import { createNodeAgentHistoryProvider } from './historyQueryService'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'
import type { RecoverySnapshotV1 } from '@einfach-agent/core/state/persistence'
import type { AgentHistoryCapability } from '@einfach-agent/core/history'

const executor = { execute: vi.fn(), select: vi.fn() }
const recovery = { listLatest: vi.fn(async () => []) }
function snapshot(): RecoverySnapshotV1 {
  return { schemaVersion: 1, sessionId: 'legacy', capturedAt: 3, generation: 1, commitMarker: 'complete',
    session: { id: 'legacy', title: 'Recovered', settings: { vendor: 'test', model: 'test' }, createdAt: 1, updatedAt: 3 },
    values: { conversation: { contextCheckpoint: null, items: [
      { id: 'one', createdAt: 1, item: { role: 'user', content: 'needle one' } },
      { id: 'two', createdAt: 2, item: { role: 'assistant', content: 'needle two' } },
    ] }, plan: { current: null, stageCheckpoints: [] }, run: null, queuedUserMessages: [],
    pendingQuestionAnswers: {}, pendingArtifacts: [], executionGraph: { version: 1, nodes: {}, order: [] },
    subagentContinuations: [] } }
}

describe('history query service', () => {
  it('fails closed on a source reconciliation warning before query I/O', async () => {
    const provider = createNodeAgentHistoryProvider({ executor, recovery, agentRollout: {
      reconcile: async () => ({ histories: [{ historyId: 'h', recordsApplied: 0, nextByteOffset: 0,
        warning: { kind: 'source', code: 'ROLLOUT_SOURCE_FAILED', message: 'broken source' } }] }),
    } })
    await expect(provider.forContext({}).listHistories({})).rejects.toMatchObject({
      code: 'AGENT_HISTORY_SOURCE_CORRUPT',
    })
    expect(executor.select).not.toHaveBeenCalled()
  })

  it('wraps a reconcile rejection before canonical or legacy I/O', async () => {
    const select = vi.fn(); const listLatest = vi.fn()
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest }, agentRollout: { reconcile: async () => { throw new Error('discovery failed') } } })
    await expect(provider.forContext({ legacyWorkspaceRoot: '/missing' }).search({ query: 'x' }))
      .rejects.toMatchObject({ code: 'AGENT_HISTORY_SOURCE_CORRUPT' })
    expect(select).not.toHaveBeenCalled(); expect(listLatest).not.toHaveBeenCalled()
  })

  it('global list stays canonical and preserves projection lag', async () => {
    const listLatest = vi.fn()
    const select = vi.fn(async (sql: string) => sql.includes('COUNT(*) count') ? [{ count: 0 }] : [])
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest }, agentRollout: { reconcile: async () => ({ histories: [{ historyId: 'h',
        recordsApplied: 0, nextByteOffset: 0, warning: { kind: 'projection', code: 'ROLLOUT_PROJECTION_FAILED',
          message: 'lag' } }] }) } })
    await expect(provider.forContext({ legacyWorkspaceRoot: '/missing' }).listHistories({}))
      .resolves.toEqual({ histories: [], warnings: [{ code: 'PROJECTION_LAG',
        message: 'Canonical history projection has not caught up yet' }] })
    expect(listLatest).not.toHaveBeenCalled()
  })

  it('pages targeted legacy items and never exposes modelItem', async () => {
    const select = vi.fn(async (sql: string) => sql.includes('COUNT(*) count') ? [{ count: 0 }] : [])
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest: async () => [snapshot()] }, agentRollout: { reconcile: async () => ({ histories: [] }) } })
    const capability = provider.forContext({}); const target = { kind: 'root' as const, conversationId: 'legacy' }
    const first = await capability.listItems({ target, limit: 1 })
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy()
    expect(first.items[0]).not.toHaveProperty('modelItem')
    const second = await capability.listItems({ target, limit: 1, cursor: first.nextCursor })
    expect(second.items.map((item) => item.itemId)).toEqual(['two'])
    const read = await capability.readItem({ target, itemId: 'one' })
    expect(read.item).not.toHaveProperty('modelItem'); expect(read.text).toContain('needle one')
    const search = await capability.search({ target, query: 'needle', limit: 1 })
    expect(search.hits[0]).not.toHaveProperty('modelItem'); expect(search.nextCursor).toBeTruthy()
  })

  it('canonical target presence suppresses filtered legacy fallback', async () => {
    const row = { history_id: 'canonical', target_kind: 'root', conversation_id: 'same', run_id: null,
      agent_path: null, title: 'Canonical', created_at: 1, updated_at: 2, complete: 1,
      last_rollout_ordinal: 0, status: 'done', item_count: 0 }
    const select = vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*) count')) return [{ count: 1 }]
      return sql.includes(' IN (') ? [] : [row]
    })
    const listLatest = vi.fn(async () => [snapshot()])
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest }, agentRollout: { reconcile: async () => ({ histories: [] }) } })
    const result = await provider.forContext({}).listHistories({
      target: { kind: 'root', conversationId: 'same' }, statuses: ['legacy'],
    })
    expect(result.histories).toEqual([]); expect(listLatest).not.toHaveBeenCalled()
  })

  it.each([
    ['list limit', (capability: AgentHistoryCapability) => capability.listHistories({ limit: 101 })],
    ['items limit', (capability: AgentHistoryCapability) => capability.listItems({ target: { kind: 'root', conversationId: 'c' }, limit: 0 })],
    ['read offset', (capability: AgentHistoryCapability) => capability.readItem({ target: { kind: 'root', conversationId: 'c' }, itemId: 'i', offset: -1 })],
    ['read limit', (capability: AgentHistoryCapability) => capability.readItem({ target: { kind: 'root', conversationId: 'c' }, itemId: 'i', limit: 20_001 })],
    ['search query', (capability: AgentHistoryCapability) => capability.search({ query: '   ' })],
    ['search limit', (capability: AgentHistoryCapability) => capability.search({ query: 'x', limit: 51 })],
    ['statuses', (capability: AgentHistoryCapability) => capability.listHistories({ statuses: ['bad' as never] })],
    ['roles', (capability: AgentHistoryCapability) => capability.listItems({ target: { kind: 'root', conversationId: 'c' }, roles: ['bad' as never] })],
    ['includeDeleted', (capability: AgentHistoryCapability) => capability.listItems({ target: { kind: 'root', conversationId: 'c' }, includeDeleted: 'yes' as never })],
  ])('rejects invalid direct %s before query and legacy I/O', async (_name, call) => {
    const select = vi.fn(); const listLatest = vi.fn()
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest }, agentRollout: { reconcile: async () => ({ histories: [] }) } })
    await expect(call(provider.forContext({ legacyWorkspaceRoot: '/missing' }))).rejects.toThrow()
    expect(select).not.toHaveBeenCalled(); expect(listLatest).not.toHaveBeenCalled()
  })

  it('re-budgets a canonical list with projection warning and keeps source continuation exact', async () => {
    const row = (id: string, updated: number) => ({ history_id: id, target_kind: 'root', conversation_id: id,
      run_id: null, agent_path: null, title: id.repeat(49_820), created_at: 1, updated_at: updated,
      complete: 1, last_rollout_ordinal: 0, status: 'done', item_count: 0 })
    const rows = [row('a', 2), row('b', 1)]
    const select = vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(*) count')) return [{ count: 2 }]
      return sql.includes('updated_at<$') ? [rows[1]] : rows
    })
    const provider = createNodeAgentHistoryProvider({ executor: { execute: vi.fn(), select } as unknown as SqlExecutor,
      recovery: { listLatest: vi.fn() }, agentRollout: { reconcile: async () => ({ histories: [{ historyId: 'a',
        recordsApplied: 0, nextByteOffset: 0, warning: { kind: 'projection', code: 'ROLLOUT_PROJECTION_FAILED', message: 'lag' } }] }) } })
    const capability = provider.forContext({}); const first = await capability.listHistories({ limit: 2 })
    expect(first.histories.map(value => value.historyId)).toEqual(['a']); expect(first.nextCursor).toBeTruthy()
    expect(first.warnings.map(value => value.code)).toEqual(['PROJECTION_LAG', 'OUTPUT_TRUNCATED'])
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(100_000)
    const second = await capability.listHistories({ limit: 2, cursor: first.nextCursor })
    expect(second.histories.map(value => value.historyId)).toEqual(['b'])
  })
})
