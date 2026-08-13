import type { TraceAttributes, TraceStatus } from './types'

const LOG_PREFIX = '[web-agent:perf]'
const DEFAULT_SLOW_MS = 100

export interface PerformanceDiagnosticOptions {
  operationId?: string
  slowMs?: number
  wallNow?: () => number
  monotonicNow?: () => number
}

export type PerformanceDiagnosticLevel = 'debug' | 'warn' | 'error'

export interface PerformanceDiagnosticLog {
  level: PerformanceDiagnosticLevel
  name: string
  attrs: TraceAttributes
}

/** Receives diagnostic output without coupling performance measurement to a host console. */
export type PerformanceDiagnosticSink = (diagnostic: PerformanceDiagnosticLog) => void

export interface PerformanceDiagnosticOperation {
  readonly operationId: string
  finish(
    status?: Exclude<TraceStatus, 'running'>,
    attrs?: TraceAttributes,
    error?: unknown,
  ): number
}

export type CompletedSpanRecorder = (name: string, input: {
  startedAt: number
  endedAt: number
  status: Exclude<TraceStatus, 'running'>
  attrs: TraceAttributes
  error?: unknown
}) => void

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
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

/** The compatibility sink used when a host does not configure diagnostic output. */
export function consolePerformanceDiagnosticSink({ level, name, attrs }: PerformanceDiagnosticLog): void {
  try {
    console[level](`${LOG_PREFIX} ${name}`, attrs)
  } catch {
    // Diagnostics must never affect the observed operation.
  }
}

function writeDiagnostic(
  sink: PerformanceDiagnosticSink,
  level: PerformanceDiagnosticLevel,
  name: string,
  attrs: TraceAttributes,
): void {
  try {
    sink({ level, name, attrs })
  } catch {
    // Diagnostics must never affect the observed operation.
  }
}

export function createPerformanceDiagnostics(
  recordCompletedSpan: CompletedSpanRecorder,
  diagnosticSink: PerformanceDiagnosticSink = consolePerformanceDiagnosticSink,
): {
  performanceNow(): number
  beginPerformanceDiagnostic(
    name: string,
    attrs?: TraceAttributes,
    options?: PerformanceDiagnosticOptions,
  ): PerformanceDiagnosticOperation
  recordPerformanceDiagnostic(
    name: string,
    durationMs: number,
    attrs?: TraceAttributes,
    options?: PerformanceDiagnosticOptions,
  ): void
} {
  function performanceNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  function beginPerformanceDiagnostic(
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

    writeDiagnostic(diagnosticSink, 'debug', `${name}.start`, { ...attrs, operationId })

    return {
      operationId,
      finish(status = 'ok', finishAttrs = {}, error) {
        if (finished) return 0
        finished = true
        const durationMs = Math.max(0, monotonicNow() - monotonicStartedAt)
        const endedAt = wallStartedAt + durationMs
        const combined = { ...attrs, ...finishAttrs, operationId, observedDurationMs: rounded(durationMs) }
        recordCompletedSpan(`perf.${name}`, {
          startedAt: wallStartedAt,
          endedAt,
          status,
          attrs: combined,
          error,
        })
        writeDiagnostic(diagnosticSink, status === 'error' ? 'error' : durationMs >= slowMs ? 'warn' : 'debug', `${name}.finish`, {
          ...combined,
          status,
          ...(error === undefined ? {} : { error: errorText(error) }),
        })
        return durationMs
      },
    }
  }

  function recordPerformanceDiagnostic(
    name: string,
    durationMs: number,
    attrs: TraceAttributes = {},
    options: PerformanceDiagnosticOptions = {},
  ): void {
    const endedAt = (options.wallNow ?? Date.now)()
    const safeDuration = Math.max(0, durationMs)
    const combined = {
      ...attrs,
      operationId: options.operationId ?? createId(),
      observedDurationMs: rounded(safeDuration),
    }
    recordCompletedSpan(`perf.${name}`, {
      startedAt: endedAt - safeDuration,
      endedAt,
      status: 'ok',
      attrs: combined,
    })
    writeDiagnostic(
      diagnosticSink,
      safeDuration >= (options.slowMs ?? DEFAULT_SLOW_MS) ? 'warn' : 'debug',
      name,
      combined,
    )
  }

  return { performanceNow, beginPerformanceDiagnostic, recordPerformanceDiagnostic }
}
