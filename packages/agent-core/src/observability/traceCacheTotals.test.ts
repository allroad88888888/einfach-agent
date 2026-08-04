import { describe, expect, it } from 'vitest'
import type { TraceLogSnapshot } from './logReader'
import { cacheTotalsFromTrace } from './traceCacheTotals'

describe('cacheTotalsFromTrace', () => {
  it('aggregates only measured llm calls from the requested run', () => {
    const snapshot: TraceLogSnapshot = {
      source: 'sqlite',
      loadedAt: 1,
      events: [],
      spans: [
        { id: 'a', traceId: 't', name: 'llm.chat', kind: 'llm', status: 'ok', startedAt: 1, attrs: { runId: 'r1', cache_hit_tk: 80, cache_miss_tk: 20 } },
        { id: 'b', traceId: 't', name: 'llm.chat', kind: 'llm', status: 'ok', startedAt: 2, attrs: { runId: 'r1', cache_hit_tk: 10, cache_miss_tk: 90 } },
        { id: 'c', traceId: 't', name: 'llm.chat', kind: 'llm', status: 'ok', startedAt: 3, attrs: { runId: 'r2', cache_hit_tk: 100, cache_miss_tk: 0 } },
        { id: 'd', traceId: 't', name: 'tool.call', kind: 'tool', status: 'ok', startedAt: 4, attrs: { runId: 'r1', cache_hit_tk: 100, cache_miss_tk: 0 } },
        { id: 'e', traceId: 't', name: 'llm.chat', kind: 'llm', status: 'ok', startedAt: 5, attrs: { runId: 'r1', cache_hit_tk: 10 } },
      ],
    }

    expect(cacheTotalsFromTrace(snapshot, 'r1')).toEqual({
      runId: 'r1',
      measuredRequests: 2,
      hitTokens: 90,
      missTokens: 110,
      hitRate: 0.45,
    })
  })

  it('returns no total when the trace has no measured cache usage for the run', () => {
    expect(cacheTotalsFromTrace({ source: 'sqlite', loadedAt: 1, spans: [], events: [] }, 'r1')).toBeUndefined()
  })
})
