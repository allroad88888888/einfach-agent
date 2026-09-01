import { describe, expect, it } from 'vitest'
import { AgentHistoryError } from '@einfach-agent/core/history'

import {
  assertRolloutCursor, decodeRolloutQueryCursor, encodeRolloutQueryCursor,
  normalizeHistoryCursorFilters, normalizeItemCursorFilters,
} from './queryCursor'

const root = { kind: 'root', conversationId: 'conversation' } as const

describe('rollout query cursor', () => {
  it('round trips normalized history and item keysets', () => {
    const histories = { kind: 'histories' as const,
      filters: normalizeHistoryCursorFilters({ target: root, statuses: ['running', 'idle', 'running'] }),
      snapshot: 4, key: { updatedAt: 9, historyId: 'history' } }
    expect(decodeRolloutQueryCursor(encodeRolloutQueryCursor(histories))).toEqual({
      ...histories, filters: { target: root, statuses: ['idle', 'running'] },
    })
    const items = { kind: 'items' as const,
      filters: normalizeItemCursorFilters({ target: root, roles: ['user', 'assistant', 'user'] }),
      snapshot: 3, key: { itemOrdinal: 2, itemId: 'item' } }
    expect(decodeRolloutQueryCursor(encodeRolloutQueryCursor(items))).toEqual({
      ...items, filters: { target: root, includeDeleted: false, roles: ['assistant', 'user'] },
    })
  })

  it('rejects unknown fields, malformed payloads, and query changes', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    for (const cursor of ['', '**', encode({ v: 2 }), encode({ v: 1, kind: 'items', filters: {
      target: root, includeDeleted: false, roles: [], extra: true,
    }, snapshot: 1, key: { itemOrdinal: 0, itemId: 'x' } })]) {
      expect(() => decodeRolloutQueryCursor(cursor)).toThrowError(AgentHistoryError)
    }
    const filters = normalizeItemCursorFilters({ target: root })
    const cursor = encodeRolloutQueryCursor({ kind: 'items', filters, snapshot: 1,
      key: { itemOrdinal: 0, itemId: 'x' } })
    expect(() => assertRolloutCursor(cursor, 'items', { ...filters, includeDeleted: true }, 1))
      .toThrowError(expect.objectContaining({ code: 'AGENT_HISTORY_INVALID_CURSOR' }))
    expect(() => assertRolloutCursor(cursor, 'items', { ...filters, roles: ['tool'] }, 1))
      .toThrowError(expect.objectContaining({ code: 'AGENT_HISTORY_INVALID_CURSOR' }))
    expect(() => assertRolloutCursor(cursor, 'items', filters, 2))
      .toThrowError(expect.objectContaining({ code: 'AGENT_HISTORY_CURSOR_STALE' }))
  })

  it('round trips nullable tombstone keysets', () => {
    const filters = normalizeItemCursorFilters({ target: root, includeDeleted: true })
    const value = { kind: 'items' as const, filters, snapshot: 2,
      key: { itemOrdinal: null, itemId: 'deleted-before-upsert' } }
    expect(decodeRolloutQueryCursor(encodeRolloutQueryCursor(value))).toEqual(value)
  })
})
