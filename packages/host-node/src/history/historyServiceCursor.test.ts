import { describe, expect, it } from 'vitest'
import { decodeHistoryServiceCursor, encodeHistoryServiceCursor } from './historyServiceCursor'
const filters = { target: { kind: 'root' as const, conversationId: 'c' }, roles: ['user'] }
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
})
