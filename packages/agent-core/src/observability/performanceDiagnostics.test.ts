import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureObservability,
  flushObservability,
  resetObservability,
} from './trace'
import type { TraceDriver, TraceEvent, TraceSpan } from './types'
import {
  beginPerformanceDiagnostic,
  recordPerformanceDiagnostic,
} from './performanceDiagnostics'

afterEach(() => {
  resetObservability()
  vi.restoreAllMocks()
})

function mockDriver(): TraceDriver & { spans: TraceSpan[]; events: TraceEvent[] } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    async writeSpan(span) {
      spans.push(span)
    },
    async writeEvent(event) {
      events.push(event)
    },
  }
}

describe('performance diagnostics', () => {
  it('records one completed span with correlation id and phase attributes', async () => {
    const driver = mockDriver()
    configureObservability({ driver })
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    let monotonic = 10
    const operation = beginPerformanceDiagnostic(
      'persistence.sessions_write',
      { queueDepth: 2 },
      {
        operationId: 'persist-7',
        wallNow: () => 1_000,
        monotonicNow: () => monotonic,
      },
    )
    monotonic = 37.5

    expect(operation.finish('ok', { payloadChars: 400 })).toBe(27.5)
    expect(operation.finish()).toBe(0)
    await flushObservability()

    expect(driver.spans).toHaveLength(1)
    expect(driver.spans[0]).toMatchObject({
      name: 'perf.persistence.sessions_write',
      status: 'ok',
      startedAt: 1_000,
      endedAt: 1_027.5,
      durationMs: 27.5,
      attrs: {
        operationId: 'persist-7',
        queueDepth: 2,
        payloadChars: 400,
        observedDurationMs: 27.5,
      },
    })
  })

  it('records an externally observed UI stall and warns above the threshold', async () => {
    const driver = mockDriver()
    configureObservability({ driver })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    recordPerformanceDiagnostic(
      'ui.event_loop_stall',
      850,
      { visibilityState: 'visible' },
      { operationId: 'stall-1', wallNow: () => 5_000, slowMs: 100 },
    )
    await flushObservability()

    expect(warn).toHaveBeenCalledOnce()
    expect(driver.spans[0]).toMatchObject({
      name: 'perf.ui.event_loop_stall',
      startedAt: 4_150,
      endedAt: 5_000,
      attrs: { operationId: 'stall-1', observedDurationMs: 850 },
    })
  })
})
