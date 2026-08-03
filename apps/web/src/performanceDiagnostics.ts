import type { ProfilerOnRenderCallback } from 'react'
import {
  performanceNow,
  recordPerformanceDiagnostic,
} from '@web-agent/core/observability/performanceDiagnostics'

const EVENT_LOOP_INTERVAL_MS = 250
const EVENT_LOOP_STALL_MS = 120
const LONG_TASK_MS = 50
const FIRST_CONTENTFUL_PAINT_SLOW_MS = 2_500

let started = false

function viewName(): string {
  return new URLSearchParams(window.location.search).get('view') ?? 'app'
}

function observeFirstContentfulPaint(): void {
  if (
    typeof PerformanceObserver === 'undefined'
    || !PerformanceObserver.supportedEntryTypes?.includes('paint')
  ) return

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name !== 'first-contentful-paint') continue
        recordPerformanceDiagnostic(
          'ui.first_contentful_paint',
          entry.startTime,
          {
            entryType: entry.entryType,
            paintName: entry.name,
            view: viewName(),
          },
          { slowMs: FIRST_CONTENTFUL_PAINT_SLOW_MS },
        )
        observer.disconnect()
        return
      }
    })
    observer.observe({ type: 'paint', buffered: true })
  } catch {
    // Older WebViews can expose the constructor without Paint Timing support.
  }
}

/**
 * Installs passive WebView probes. They keep no application state and only
 * emit after a visible-page stall/long-task crosses the diagnostic threshold.
 */
export function startUiPerformanceDiagnostics(): void {
  if (started || typeof window === 'undefined') return
  started = true
  observeFirstContentfulPaint()

  let expectedAt = performanceNow() + EVENT_LOOP_INTERVAL_MS
  window.setInterval(() => {
    const observedAt = performanceNow()
    const lagMs = Math.max(0, observedAt - expectedAt)
    expectedAt = observedAt + EVENT_LOOP_INTERVAL_MS
    if (document.visibilityState !== 'visible' || lagMs < EVENT_LOOP_STALL_MS) return
    recordPerformanceDiagnostic(
      'ui.event_loop_stall',
      lagMs,
      {
        intervalMs: EVENT_LOOP_INTERVAL_MS,
        thresholdMs: EVENT_LOOP_STALL_MS,
        visibilityState: document.visibilityState,
        view: viewName(),
      },
      { slowMs: EVENT_LOOP_STALL_MS },
    )
  }, EVENT_LOOP_INTERVAL_MS)

  if (
    typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_MS) continue
          recordPerformanceDiagnostic(
            'ui.long_task',
            entry.duration,
            {
              entryType: entry.entryType,
              startTime: entry.startTime,
              thresholdMs: LONG_TASK_MS,
              view: viewName(),
            },
            { slowMs: LONG_TASK_MS },
          )
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // WebKit versions without Long Tasks support still use the interval probe.
    }
  }
}

export const reportReactCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  const thresholdMs = id === 'PlanPanel' ? 24 : 50
  if (actualDuration < thresholdMs) return
  recordPerformanceDiagnostic(
    'ui.react_commit',
    actualDuration,
    {
      component: id,
      phase,
      actualDurationMs: actualDuration,
      baseDurationMs: baseDuration,
      renderStartTime: startTime,
      commitTime,
      thresholdMs,
    },
    { slowMs: thresholdMs },
  )
}
