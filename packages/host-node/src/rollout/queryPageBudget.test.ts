import { describe, expect, it } from 'vitest'
import { assertEmptyQueryPageFits, fitQueryPage } from './queryPageBudget'

describe('query page budget', () => {
  it('measures the complete final envelope and retains a continuation item', () => {
    const values = Array.from({ length: 60 }, (_, index) => ({ id: index, text: '界'.repeat(2_000) }))
    const page = fitQueryPage(values.length, (count, truncated) => ({
      identity: 'target', items: values.slice(0, count),
      ...(truncated ? { nextCursor: 'cursor', warnings: [{ code: 'OUTPUT_TRUNCATED' }] } : { warnings: [] }),
    }))
    expect(page.includedCount).toBeGreaterThan(0)
    expect(page.includedCount).toBeLessThan(values.length)
    expect(JSON.stringify(page.result).length).toBeLessThanOrEqual(100_000)
  })

  it('rejects a first candidate or identity that cannot fit', () => {
    expect(() => fitQueryPage(1, count => ({ values: count ? ['x'.repeat(100_001)] : [] }))).toThrow(RangeError)
    expect(() => assertEmptyQueryPageFits({ identity: 'x'.repeat(100_001), values: [] })).toThrow(RangeError)
  })
})
