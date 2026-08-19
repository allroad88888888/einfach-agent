import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureObservability,
  flushObservability,
  resetObservability,
  type TraceDriver,
  type TraceEvent,
  type TraceSpan,
} from '@einfach-agent/core/observability'
import { startUiPerformanceDiagnostics } from './performanceDiagnostics'

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

afterEach(() => {
  resetObservability()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('startUiPerformanceDiagnostics', () => {
  it('records buffered first contentful paint once', async () => {
    const driver = mockDriver()
    const observed: PerformanceObserverInit[] = []
    configureObservability({ driver })
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(window, 'setInterval').mockImplementation(() => undefined as never)

    class PaintObserver {
      static supportedEntryTypes = ['paint']

      constructor(private readonly callback: PerformanceObserverCallback) {}

      disconnect = vi.fn()

      observe(options: PerformanceObserverInit): void {
        observed.push(options)
        this.callback(
          {
            getEntries: () => [
              { name: 'first-contentful-paint', entryType: 'paint', startTime: 840 },
            ] as PerformanceEntry[],
          } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        )
      }
    }

    vi.stubGlobal('PerformanceObserver', PaintObserver)
    startUiPerformanceDiagnostics()
    startUiPerformanceDiagnostics()
    await flushObservability()

    expect(observed).toEqual([{ type: 'paint', buffered: true }])
    expect(driver.spans).toContainEqual(expect.objectContaining({
      name: 'perf.ui.first_contentful_paint',
      status: 'ok',
      attrs: expect.objectContaining({
        entryType: 'paint',
        paintName: 'first-contentful-paint',
        observedDurationMs: 840,
        view: 'app',
      }),
    }))
  })
})
