import { errorMessage, redactAttributesWithPreviews, truncatePayload } from './redact'
import { createPerformanceDiagnostics } from './performanceDiagnosticPort'
import type {
  AddEventInput,
  CompletedSpanInput,
  ObservabilityPort,
  StartSpanInput,
  TraceAttributesInput,
} from './port'
import type { TraceAttributes, TraceDriver, TraceEvent, TraceSpan, TraceStatus } from './types'

export type { TraceAttributesInput } from './port'

interface ConfigurableObservabilityPort extends ObservabilityPort {
  configure(deps: { driver?: TraceDriver }): void
  reset(): void
  flush(): Promise<void>
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function snapshotSpan(span: TraceSpan): TraceSpan {
  return { ...span, attrs: redactAttributesWithPreviews(span.attrs) }
}

function snapshotEvent(event: TraceEvent): TraceEvent {
  return { ...event, attrs: redactAttributesWithPreviews(event.attrs) }
}

function initialAttrs(attrs: TraceAttributesInput | undefined): TraceAttributes | undefined {
  return typeof attrs === 'function' ? undefined : attrs
}

function resolveAttrs(attrs: TraceAttributesInput | undefined): TraceAttributes | undefined {
  return typeof attrs === 'function' ? attrs() : attrs
}

function createConfigurableObservabilityPort(): ConfigurableObservabilityPort {
  let driver: TraceDriver | undefined
  let queue: Promise<void> = Promise.resolve()
  const activeSpans = new Map<string, TraceSpan>()

  function enqueue(work: (current: TraceDriver) => Promise<void>): void {
    const current = driver
    if (!current) return
    queue = queue.then(() => work(current)).catch(() => {})
  }

  function recordCompletedSpan(name: string, input: CompletedSpanInput): TraceSpan {
    const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : Date.now()
    const endedAt = Number.isFinite(input.endedAt)
      ? Math.max(startedAt, input.endedAt)
      : Math.max(startedAt, Date.now())
    const span: TraceSpan = {
      id: createId(),
      traceId: input.traceId ?? createId(),
      parentSpanId: input.parentSpanId,
      name,
      kind: input.kind ?? 'internal',
      status: input.status ?? 'ok',
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      attrs: initialAttrs(input.attrs),
      error: input.error === undefined ? undefined : errorMessage(input.error),
    }
    if (driver) {
      span.attrs = resolveAttrs(input.attrs)
      const snapshot = snapshotSpan(span)
      enqueue((current) => current.writeSpan(snapshot))
    }
    return span
  }

  const diagnostics = createPerformanceDiagnostics(recordCompletedSpan)

  return {
    configure(deps) {
      driver = deps.driver
    },
    reset() {
      driver = undefined
      activeSpans.clear()
      queue = Promise.resolve()
    },
    flush() {
      return queue.catch(() => {})
    },
    runTraceKey(sessionId, runId) {
      return `agent.turn:${sessionId}:${runId}`
    },
    bindActiveSpan(key, span) {
      activeSpans.set(key, span)
    },
    getActiveSpan(key) {
      return activeSpans.get(key)
    },
    clearActiveSpan(key, span) {
      if (!span || activeSpans.get(key)?.id === span.id) activeSpans.delete(key)
    },
    startSpan(name, input: StartSpanInput = {}) {
      const parent = input.parent
      const span: TraceSpan = {
        id: createId(),
        traceId: input.traceId ?? parent?.traceId ?? createId(),
        parentSpanId: input.parentSpanId ?? parent?.id,
        name,
        kind: input.kind ?? 'internal',
        status: 'running',
        startedAt: Date.now(),
        attrs: initialAttrs(input.attrs),
      }
      if (driver) {
        span.attrs = resolveAttrs(input.attrs)
        const snapshot = snapshotSpan(span)
        enqueue((current) => current.writeSpan(snapshot))
      }
      return span
    },
    recordCompletedSpan,
    addEvent(name, input: AddEventInput = {}) {
      if (!driver) return
      const span = input.span
      const traceId = input.traceId ?? span?.traceId
      if (!traceId) return
      const event: TraceEvent = {
        id: createId(),
        traceId,
        spanId: input.spanId ?? span?.id,
        name,
        timestamp: Date.now(),
        attrs: resolveAttrs(input.attrs),
      }
      const snapshot = snapshotEvent(event)
      enqueue((current) => current.writeEvent(snapshot))
    },
    endSpan(span, status, attrs, error) {
      if (!span || span.endedAt !== undefined) return
      const endedAt = Date.now()
      span.status = status
      span.endedAt = endedAt
      span.durationMs = Math.max(0, endedAt - span.startedAt)
      const resolvedAttrs = driver ? resolveAttrs(attrs) : initialAttrs(attrs)
      if (resolvedAttrs) span.attrs = { ...(span.attrs ?? {}), ...resolvedAttrs }
      if (error !== undefined) span.error = errorMessage(error)
      if (driver) {
        const snapshot = snapshotSpan(span)
        enqueue((current) => current.writeSpan(snapshot))
      }
    },
    previewPayload(value, limit, options) {
      return truncatePayload(value, limit, options)
    },
    ...diagnostics,
  }
}

const defaultObservabilityPort = createConfigurableObservabilityPort()

/** Creates an independent silent port for explicit Core assembly. */
export function createObservabilityPort(): ObservabilityPort {
  return createConfigurableObservabilityPort()
}

/** The compatibility port assembled by configureObservability in the Web entry point. */
export function getDefaultObservabilityPort(): ObservabilityPort {
  return defaultObservabilityPort
}

export function configureObservability(deps: { driver?: TraceDriver }): void {
  defaultObservabilityPort.configure(deps)
}

export function resetObservability(): void {
  defaultObservabilityPort.reset()
}

export function flushObservability(): Promise<void> {
  return defaultObservabilityPort.flush()
}

export const runTraceKey = defaultObservabilityPort.runTraceKey
export const bindActiveSpan = defaultObservabilityPort.bindActiveSpan
export const getActiveSpan = defaultObservabilityPort.getActiveSpan
export const clearActiveSpan = defaultObservabilityPort.clearActiveSpan
export const startSpan = defaultObservabilityPort.startSpan
export const recordCompletedSpan = defaultObservabilityPort.recordCompletedSpan
export const addEvent = defaultObservabilityPort.addEvent
export const endSpan = defaultObservabilityPort.endSpan

export async function withSpan<T>(
  name: string,
  input: StartSpanInput,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const span = defaultObservabilityPort.startSpan(name, input)
  try {
    const value = await fn(span)
    defaultObservabilityPort.endSpan(span, 'ok')
    return value
  } catch (error) {
    defaultObservabilityPort.endSpan(
      span,
      error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error',
      undefined,
      error,
    )
    throw error
  }
}
