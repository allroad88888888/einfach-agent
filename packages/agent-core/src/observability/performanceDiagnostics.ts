import { recordCompletedSpan } from './trace'
import type { TraceAttributes, TraceStatus } from './types'

const LOG_PREFIX = '[web-agent:perf]'
const DEFAULT_SLOW_MS = 100

export interface PerformanceDiagnosticOptions {
  /** A stable id shared by the WebView and Rust halves of one operation. */
  operationId?: string
  /** Normal operations use debug; operations at or above this threshold use warn. */
  slowMs?: number
  /** Override the wall clock in tests. */
  wallNow?: () => number
  /** Override the monotonic clock in tests. */
  monotonicNow?: () => number
}

export interface PerformanceDiagnosticOperation {
  readonly operationId: string
  finish(
    status?: Exclude<TraceStatus, 'running'>,
    attrs?: TraceAttributes,
    error?: unknown,
  ): number
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function errorText(error: unknown): string | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function safeConsole(
  level: 'debug' | 'warn' | 'error',
  name: string,
  attrs: TraceAttributes,
): void {
  try {
    console[level](`${LOG_PREFIX} ${name}`, attrs)
  } catch {
    // Diagnostics must never affect the observed operation.
  }
}

/**
 * Times an operation without retaining or serializing its payload. Completion
 * is stored as one observability span and mirrored to the WebView console.
 */
export function beginPerformanceDiagnostic(
  name: string,
  attrs: TraceAttributes = {},
  options: PerformanceDiagnosticOptions = {},
): PerformanceDiagnosticOperation {
  const operationId = options.operationId ?? createId()
  const wallNow = options.wallNow ?? Date.now
  const monotonicNow = options.monotonicNow ?? performanceNow
  const wallStartedAt = wallNow()
  const monotonicStartedAt = monotonicNow()
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS
  let finished = false

  safeConsole('debug', `${name}.start`, { ...attrs, operationId })

  return {
    operationId,
    finish(status = 'ok', finishAttrs = {}, error) {
      if (finished) return 0
      finished = true
      const durationMs = Math.max(0, monotonicNow() - monotonicStartedAt)
      const endedAt = wallStartedAt + durationMs
      const combined = {
        ...attrs,
        ...finishAttrs,
        operationId,
        observedDurationMs: rounded(durationMs),
      }
      recordCompletedSpan(`perf.${name}`, {
        startedAt: wallStartedAt,
        endedAt,
        status,
        attrs: combined,
        error,
      })
      safeConsole(
        status === 'error' ? 'error' : durationMs >= slowMs ? 'warn' : 'debug',
        `${name}.finish`,
        {
          ...combined,
          status,
          ...(error === undefined ? {} : { error: errorText(error) }),
        },
      )
      return durationMs
    },
  }
}

/** Records a duration observed by an external clock, such as event-loop lag. */
export function recordPerformanceDiagnostic(
  name: string,
  durationMs: number,
  attrs: TraceAttributes = {},
  options: PerformanceDiagnosticOptions = {},
): void {
  const wallNow = options.wallNow ?? Date.now
  const endedAt = wallNow()
  const operationId = options.operationId ?? createId()
  const safeDuration = Math.max(0, durationMs)
  const combined = {
    ...attrs,
    operationId,
    observedDurationMs: rounded(safeDuration),
  }
  recordCompletedSpan(`perf.${name}`, {
    startedAt: endedAt - safeDuration,
    endedAt,
    status: 'ok',
    attrs: combined,
  })
  safeConsole(
    safeDuration >= (options.slowMs ?? DEFAULT_SLOW_MS) ? 'warn' : 'debug',
    name,
    combined,
  )
}
