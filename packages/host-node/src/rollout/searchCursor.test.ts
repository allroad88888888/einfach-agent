import { AgentHistoryError } from '@einfach-agent/core/history'
import { describe, expect, it } from 'vitest'

import { assertSearchCursor, encodeSearchCursor, normalizeSearchFilters } from './searchCursor'

const target = { kind: 'root', conversationId: 'conversation' } as const
const snapshot = { eventCount: 4, watermark: 4 }
const key = { rank: -1, updatedAt: 5, historyId: 'history', itemOrdinal: 2, itemId: 'item' }

describe('history search cursor', () => {
  it('round-trips normalized filters and exact key', () => {
    const filters = normalizeSearchFilters({ query: ' query ', target, roles: ['user', 'assistant', 'user'] })
    const encoded = encodeSearchCursor({ filters, snapshot, key })
    expect(assertSearchCursor(encoded, filters, snapshot)?.key).toEqual(key)
  })

  it('rejects changed filters, stale snapshots, unknown fields, and noncanonical encoding', () => {
    const filters = normalizeSearchFilters({ query: 'query', target, roles: ['user'] })
    const encoded = encodeSearchCursor({ filters, snapshot, key })
    expect(() => assertSearchCursor(encoded, { ...filters, roles: ['tool'] }, snapshot))
      .toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
    expect(() => assertSearchCursor(encoded, filters, { ...snapshot, eventCount: 5 }))
      .toMatchErrorCode('AGENT_HISTORY_CURSOR_STALE')
    const extra = Buffer.from(JSON.stringify({ v: 1, kind: 'search', filters, snapshot, key, extra: true })).toString('base64url')
    expect(() => assertSearchCursor(extra, filters, snapshot)).toThrow(AgentHistoryError)
    expect(() => assertSearchCursor(`${encoded}=`, filters, snapshot)).toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
  })

  it('rejects recursively invalid targets, snapshots, and key values', () => {
    expect(() => normalizeSearchFilters({ query: 'q', target: { ...target, runId: 'extra' } as never }))
      .toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
    expect(() => normalizeSearchFilters({ query: 'q', target: { kind: 'root', conversationId: '' } }))
      .toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
    const filters = normalizeSearchFilters({ query: 'q', target })
    for (const changed of [
      { snapshot: { eventCount: -1, watermark: 4 }, key },
      { snapshot, key: { ...key, itemOrdinal: 0.5 } },
      { snapshot, key: { ...key, updatedAt: Number.MAX_SAFE_INTEGER + 1 } },
      { snapshot, key: { ...key, rank: Number.POSITIVE_INFINITY } },
      { snapshot, key: { ...key, historyId: '' } },
    ]) {
      const encoded = encodeSearchCursor({ filters, ...changed })
      expect(() => assertSearchCursor(encoded, filters, snapshot)).toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
    }
    const nestedExtra = Buffer.from(JSON.stringify({ v: 1, kind: 'search',
      filters: { ...filters, target: { ...target, extra: true } }, snapshot, key })).toString('base64url')
    expect(() => assertSearchCursor(nestedExtra, filters, snapshot)).toMatchErrorCode('AGENT_HISTORY_INVALID_CURSOR')
  })
})

declare module 'vitest' {
  interface Assertion<T> { toMatchErrorCode(code: string): T }
}
expect.extend({
  toMatchErrorCode(received: () => unknown, code: string) {
    try { received() } catch (error) {
      return { pass: error instanceof AgentHistoryError && error.code === code,
        message: () => `expected error code ${code}` }
    }
    return { pass: false, message: () => `expected error code ${code}` }
  },
})
