import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AgentHistoryTarget } from './agentHistoryTarget'
import {
  AGENT_HISTORY_ITEM_PREVIEW_MAX_CHARS,
  AGENT_HISTORY_LIST_DEFAULT_LIMIT,
  AGENT_HISTORY_LIST_MAX_LIMIT,
  AGENT_HISTORY_PAGE_MAX_CHARS,
  AGENT_HISTORY_READ_DEFAULT_LIMIT,
  AGENT_HISTORY_READ_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_DEFAULT_LIMIT,
  AGENT_HISTORY_SEARCH_MAX_LIMIT,
  AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS,
  AGENT_HISTORY_SEARCH_SNIPPET_MAX_CHARS,
  AgentHistoryError,
  type AgentHistoryCapability,
  type AgentHistoryCapabilityProvider,
  type AgentHistoryItemSummary,
  type AgentHistorySearchHit,
  type AgentHistorySummary,
  type ListAgentHistoryItemsInput,
  type MaterializedAgentHistoryItemSummary,
  type UnknownAgentHistoryItemTombstoneSummary,
} from './historyQuery'

describe('history query contract', () => {
  it('publishes the fixed query limits', () => {
    expect([
      AGENT_HISTORY_LIST_DEFAULT_LIMIT, AGENT_HISTORY_LIST_MAX_LIMIT,
      AGENT_HISTORY_SEARCH_DEFAULT_LIMIT, AGENT_HISTORY_SEARCH_MAX_LIMIT,
      AGENT_HISTORY_ITEM_PREVIEW_MAX_CHARS, AGENT_HISTORY_READ_DEFAULT_LIMIT,
      AGENT_HISTORY_READ_MAX_LIMIT, AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS,
      AGENT_HISTORY_SEARCH_SNIPPET_MAX_CHARS,
      AGENT_HISTORY_PAGE_MAX_CHARS,
    ]).toEqual([20, 100, 20, 50, 2_000, 20_000, 20_000, 1_000, 1_000, 100_000])
  })

  it('models root, child, running, terminal, and legacy histories', () => {
    const root: AgentHistoryTarget = { kind: 'root', conversationId: 'conversation' }
    const child: AgentHistoryTarget = {
      kind: 'child', conversationId: 'conversation', runId: 'run', agentPath: '/root/research',
    }
    const histories: AgentHistorySummary[] = [
      { historyId: '1', target: root, title: 'root', createdAt: 1, updatedAt: 2, status: 'running', complete: false, itemCount: 2 },
      { historyId: '2', target: child, title: 'child', createdAt: 1, updatedAt: 3, status: 'done', complete: true, itemCount: 1 },
      { historyId: '3', target: root, title: 'old', createdAt: 1, updatedAt: 1, status: 'legacy', complete: false, itemCount: 0 },
    ]
    expect(histories.map(history => [history.status, history.complete])).toEqual([
      ['running', false], ['done', true], ['legacy', false],
    ])
  })

  it('models normalized item role filters and content-free tombstones', () => {
    const input: ListAgentHistoryItemsInput = {
      target: { kind: 'root', conversationId: 'conversation' },
      roles: ['assistant', 'tool'],
      includeDeleted: true,
    }
    const tombstone: AgentHistoryItemSummary = {
      historyId: 'history', itemId: 'deleted-before-upsert', itemOrdinal: null,
      materialized: false, createdAt: null, role: null, preview: '', pending: false,
      planStageId: null, deleted: true,
    }
    expect(input.roles).toEqual(['assistant', 'tool'])
    expect(tombstone).toMatchObject({ itemOrdinal: null, createdAt: null, role: null, preview: '' })
  })

  it('narrows the complete list item object with one materialized branch', () => {
    function classify(item: AgentHistoryItemSummary): string {
      if (item.materialized) {
        expectTypeOf(item).toEqualTypeOf<MaterializedAgentHistoryItemSummary>()
        return `${item.itemOrdinal}:${item.createdAt}:${item.role}:${item.deleted}`
      }
      expectTypeOf(item).toEqualTypeOf<UnknownAgentHistoryItemTombstoneSummary>()
      return `${item.itemOrdinal}:${item.createdAt}:${item.role}:${item.preview}:${item.deleted}`
    }
    const materialized: MaterializedAgentHistoryItemSummary = {
      materialized: true, historyId: 'history', itemId: 'known', itemOrdinal: 1,
      createdAt: 2, role: 'assistant', preview: 'known', pending: false,
      planStageId: null, deleted: true,
    }
    const unknown: UnknownAgentHistoryItemTombstoneSummary = {
      materialized: false, historyId: 'history', itemId: 'unknown', itemOrdinal: null,
      createdAt: null, role: null, preview: '', pending: false, planStageId: null, deleted: true,
    }
    expect([classify(materialized), classify(unknown)]).toEqual([
      '1:2:assistant:true', 'null:null:null::true',
    ])
  })

  it('requires search hits to have materialized sortable content', () => {
    expectTypeOf<AgentHistorySearchHit['itemOrdinal']>().toEqualTypeOf<number>()
    expectTypeOf<AgentHistorySearchHit['createdAt']>().toEqualTypeOf<number>()
    expectTypeOf<AgentHistorySearchHit['role']>().toEqualTypeOf<'system' | 'user' | 'assistant' | 'tool'>()
  })

  it('defines all four capability methods and context-only legacy location', () => {
    expectTypeOf<AgentHistoryCapability>().toHaveProperty('listHistories')
    expectTypeOf<AgentHistoryCapability>().toHaveProperty('listItems')
    expectTypeOf<AgentHistoryCapability>().toHaveProperty('readItem')
    expectTypeOf<AgentHistoryCapability>().toHaveProperty('search')
    expectTypeOf<Parameters<AgentHistoryCapabilityProvider['forContext']>[0]>()
      .toEqualTypeOf<{ readonly legacyWorkspaceRoot?: string }>()
  })

  it('preserves stable typed error codes', () => {
    const error = new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'stale')
    expect(error).toMatchObject({ name: 'AgentHistoryError', code: 'AGENT_HISTORY_CURSOR_STALE' })
  })
})
