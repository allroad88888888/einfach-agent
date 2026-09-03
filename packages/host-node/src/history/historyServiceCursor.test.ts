import { describe, expect, it } from 'vitest'
import { decodeHistoryServiceCursor, encodeHistoryServiceCursor } from './historyServiceCursor'
const filters = { target: { kind: 'root' as const, conversationId: 'c' }, roles: ['user'] }
function previousCursor(kind: 'items' | 'search', oldFilters: unknown, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, filters: oldFilters, offset })).toString('base64url')
}
describe('legacy service cursor', () => {
  it('round trips offset and normalized filters', () => {
    expect(decodeHistoryServiceCursor(encodeHistoryServiceCursor('items', filters, 2), 'items', filters)).toBe(2)
  })
  it('rejects a changed query kind or filters', () => {
    const cursor = encodeHistoryServiceCursor('items', filters, 2)
    expect(() => decodeHistoryServiceCursor(cursor, 'search', filters)).toThrow('Invalid legacy history cursor')
    expect(() => decodeHistoryServiceCursor(cursor, 'items', { ...filters, roles: ['tool'] })).toThrow()
  })
  it('rejects oversized encoded input before decode', () => {
    expect(() => decodeHistoryServiceCursor('x'.repeat(100_001), 'items', filters)).toThrow('too large')
  })
  it('accepts an items cursor whose pre-upgrade root target used caller field order', () => {
    const oldFilters = { target: { conversationId: 'c', kind: 'root' },
      roles: ['user'], includeDeleted: false }
    const currentFilters = { target: { kind: 'root' as const, conversationId: 'c' },
      roles: ['user'], includeDeleted: false }
    expect(decodeHistoryServiceCursor(previousCursor('items', oldFilters, 3),
      'items', currentFilters)).toBe(3)
  })
  it('accepts a search cursor whose pre-upgrade child target used caller field order', () => {
    const oldFilters = { target: { agentPath: '/root/research', runId: 'run',
      conversationId: 'c', kind: 'child' }, query: 'needle', roles: ['assistant'] }
    const currentFilters = { target: { kind: 'child' as const, conversationId: 'c',
      runId: 'run', agentPath: '/root/research' }, query: 'needle', roles: ['assistant'] }
    expect(decodeHistoryServiceCursor(previousCursor('search', oldFilters, 4),
      'search', currentFilters)).toBe(4)
  })
})
