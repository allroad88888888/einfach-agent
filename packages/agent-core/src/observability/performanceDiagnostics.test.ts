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
  it('缺省时逐字沿用 console 输出', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    configureObservability({})

    recordPerformanceDiagnostic(
      'cli.default_output',
      1,
      { queueDepth: 2 },
      { operationId: 'default-1', wallNow: () => 1_000 },
    )

    expect(debug).toHaveBeenCalledExactlyOnceWith('[web-agent:perf] cli.default_output', {
      queueDepth: 2,
      operationId: 'default-1',
      observedDurationMs: 1,
    })
  })

  it('缺省时将失败操作写入 console.error', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    configureObservability({})
    let monotonic = 10
    const operation = beginPerformanceDiagnostic(
      'cli.default_failure',
      { queueDepth: 2 },
      { operationId: 'failure-1', wallNow: () => 1_000, monotonicNow: () => monotonic },
    )
    monotonic = 13
    operation.finish('error', { payloadChars: 4 }, new Error('失败'))

    expect(debug).toHaveBeenCalledExactlyOnceWith('[web-agent:perf] cli.default_failure.start', {
      queueDepth: 2,
      operationId: 'failure-1',
    })
    expect(error).toHaveBeenCalledExactlyOnceWith('[web-agent:perf] cli.default_failure.finish', {
      queueDepth: 2,
      payloadChars: 4,
      operationId: 'failure-1',
      observedDurationMs: 3,
      status: 'error',
      error: '失败',
    })
  })

  it('把诊断输出交给注入的 sink', () => {
    const sink = vi.fn()
    configureObservability({ performanceDiagnosticSink: sink })

    recordPerformanceDiagnostic(
      'cli.injected_output',
      101,
      { queueDepth: 3 },
      { operationId: 'injected-1', wallNow: () => 1_000 },
    )

    expect(sink).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      name: 'cli.injected_output',
      attrs: {
        queueDepth: 3,
        operationId: 'injected-1',
        observedDurationMs: 101,
      },
    })
  })

  it('允许宿主静默诊断输出', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureObservability({ performanceDiagnosticSink: () => {} })

    recordPerformanceDiagnostic('cli.silent_output', 101, {}, { operationId: 'silent-1' })

    expect(debug).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

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

    expect(warn).toHaveBeenCalledExactlyOnceWith('[web-agent:perf] ui.event_loop_stall', {
      visibilityState: 'visible',
      operationId: 'stall-1',
      observedDurationMs: 850,
    })
    expect(driver.spans[0]).toMatchObject({
      name: 'perf.ui.event_loop_stall',
      startedAt: 4_150,
      endedAt: 5_000,
      attrs: { operationId: 'stall-1', observedDurationMs: 850 },
    })
  })
})
