import { describe, expect, it } from 'vitest'
import { normalizeHistoryItemsInput, normalizeHistoryListInput, normalizeHistoryReadInput,
  normalizeHistorySearchInput } from './historyInput'

const target = { kind: 'root' as const, conversationId: 'c' }
describe('history capability input', () => {
  it('normalizes defaults and trimmed Unicode search query', () => {
    expect(normalizeHistoryListInput({}).limit).toBe(20)
    expect(normalizeHistorySearchInput({ query: '  😀  ' })).toMatchObject({ query: '😀', limit: 20 })
  })
  it.each([
    () => normalizeHistoryListInput({ limit: 101 }),
    () => normalizeHistoryItemsInput({ target, limit: 0 }),
    () => normalizeHistoryReadInput({ target, itemId: 'i', offset: -1 }),
    () => normalizeHistoryReadInput({ target, itemId: 'i', limit: 20_001 }),
    () => normalizeHistorySearchInput({ query: '   ' }),
    () => normalizeHistorySearchInput({ query: 'x', limit: 51 }),
    () => normalizeHistoryListInput({ statuses: ['bogus' as never] }),
    () => normalizeHistoryItemsInput({ target, roles: ['bogus' as never] }),
  ])('rejects invalid direct capability input', (run) => expect(run).toThrow())
})
