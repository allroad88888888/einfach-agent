import { describe, expect, it } from 'vitest'
import { accumulateCacheTotals } from './runLoopTelemetry'

describe('run cache totals', () => {
  it('keeps one run total when compaction changes the request projection', () => {
    const beforeCompaction = accumulateCacheTotals(undefined, {
      prompt_cache_hit_tokens: 96,
      prompt_cache_miss_tokens: 4,
    }, 'run-1')
    const afterCompaction = accumulateCacheTotals(beforeCompaction, {
      prompt_cache_hit_tokens: 20,
      prompt_cache_miss_tokens: 80,
    }, 'run-1')

    expect(afterCompaction).toEqual({
      runId: 'run-1',
      measuredRequests: 2,
      hitTokens: 116,
      missTokens: 84,
      hitRate: 0.58,
    })
  })

  it('does not mix cache usage from a different run', () => {
    const firstRun = accumulateCacheTotals(undefined, {
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
    }, 'run-1')
    const nextRun = accumulateCacheTotals(firstRun, {
      prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 90,
    }, 'run-2')

    expect(nextRun).toEqual({
      runId: 'run-2',
      measuredRequests: 1,
      hitTokens: 10,
      missTokens: 90,
      hitRate: 0.1,
    })
  })
})
