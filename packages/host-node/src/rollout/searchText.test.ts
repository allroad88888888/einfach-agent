import { describe, expect, it } from 'vitest'

import { agentHistoryMatchExpression } from './searchText'

describe('history FTS query text', () => {
  it('quotes tokens so operators and quotes cannot become FTS syntax', () => {
    expect(agentHistoryMatchExpression('  alpha OR "beta" -gamma  '))
      .toBe('"alpha" AND "OR" AND "beta" AND "gamma"')
    expect(agentHistoryMatchExpression('中文 搜索')).toBe('"中文" AND "搜索"')
  })

  it('rejects empty and overlong Unicode queries', () => {
    expect(() => agentHistoryMatchExpression('   ')).toThrow(RangeError)
    expect(() => agentHistoryMatchExpression('😀'.repeat(1_001))).toThrow(RangeError)
    expect(agentHistoryMatchExpression('😀')).toBe('"😀"')
  })
})
