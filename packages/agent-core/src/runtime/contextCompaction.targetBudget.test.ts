import { describe, expect, it } from 'vitest'
import type { ModelItem } from '@web-agent/ai'
import { compactContext, estimateItemsTokens } from './contextCompaction'

function historyThatNeedsCompaction(): ModelItem[] {
  const items: ModelItem[] = [{ role: 'system', content: 'system' }]
  for (let index = 0; index < 8; index += 1) {
    items.push({ role: 'user', content: `question-${index}-${'q'.repeat(800)}` })
    items.push({ role: 'assistant', content: `answer-${index}-${'a'.repeat(800)}` })
  }
  items.push({ role: 'user', content: 'latest request' })
  return items
}

describe('compactContext targetTokens', () => {
  it('only applies after the actual request budget overflows and keeps the real budget contract', () => {
    const items = historyThatNeedsCompaction()
    const actualBudget = Math.floor(estimateItemsTokens(items) * 0.8)
    const targetBudget = Math.floor(actualBudget * 0.6)

    const result = compactContext(items, { maxTokens: actualBudget, targetTokens: targetBudget })

    expect(result.compacted).toBe(true)
    expect(result.withinBudget).toBe(true)
    expect(result.effectiveBudgetTokens).toBe(actualBudget)
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(targetBudget)
  })

  it('does not compact a request that already fits the real budget just to reach the target', () => {
    const items = historyThatNeedsCompaction()

    const result = compactContext(items, {
      maxTokens: estimateItemsTokens(items) + 1,
      targetTokens: 1,
    })

    expect(result.items).toBe(items)
    expect(result.compacted).toBe(false)
  })
})
