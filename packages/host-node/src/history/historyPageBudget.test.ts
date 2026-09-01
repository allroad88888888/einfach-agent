import { describe, expect, it } from 'vitest'
import { fitHistoryPage } from './historyPageBudget'
describe('history page budget', () => {
  it('trims candidates against the complete envelope', () => {
    const values = ['x'.repeat(60_000), 'y'.repeat(60_000)]
    expect(fitHistoryPage(values, (count) => ({ values: values.slice(0, count), warnings: [] }))).toBe(1)
  })
  it('rejects an unrepresentable first value', () => {
    const values = ['x'.repeat(100_001)]
    expect(() => fitHistoryPage(values, (count) => ({ values: values.slice(0, count) }))).toThrow(RangeError)
  })
})
