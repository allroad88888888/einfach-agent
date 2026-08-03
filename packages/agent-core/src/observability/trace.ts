import { errorMessage, redactAttributesWithPreviews } from './redact'
import type { SpanKind, TraceAttributes, TraceDriver, TraceEvent, TraceSpan, TraceStatus } from './types'

export type TraceAttributesInput = TraceAttributes | (() => TraceAttributes)

type SpanInput = {
  kind?: SpanKind
  parent?: TraceSpan
  traceId?: string
  parentSpanId?: string
  attrs?: TraceAttributesInput
}

type EventInput = {
  span?: TraceSpan
  traceId?: string
  spanId?: string
  attrs?: TraceAttributesInput
}

type CompletedSpanInput = {
  kind?: SpanKind
  traceId?: string
  parentSpanId?: string
  startedAt: number
  endedAt: number
  status?: Exclude<TraceStatus, 'running'>
  attrs?: TraceAttributesInput
  error?: unknown
}

let driver: TraceDriver | undefined
let queue: Promise<void> = Promise.resolve()
const activeSpans = new Map<string, TraceSpan>()

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function snapshotSpan(span: TraceSpan): TraceSpan {
  return {
    ...span,
    attrs: redactAttributesWithPreviews(span.attrs),
  }
}

function snapshotEvent(event: TraceEvent): TraceEvent {
  return {
    ...event,
    attrs: redactAttributesWithPreviews(event.attrs),
  }
}

function initialAttrs(attrs: TraceAttributesInput | undefined): TraceAttributes | undefined {
  return typeof attrs === 'function' ? undefined : attrs
}

function resolveAttrs(attrs: TraceAttributesInput | undefined): TraceAttributes | undefined {
  return typeof attrs === 'function' ? attrs() : attrs
}

function enqueue(work: (driver: TraceDriver) => Promise<void>): void {
  const current = driver
  if (!current) return
  queue = queue.then(() => work(current)).catch(() => {})
}

export function configureObservability(deps: { driver?: TraceDriver }): void {
  driver = deps.driver
}

export function resetObservability(): void {
  driver = undefined
  activeSpans.clear()
  queue = Promise.resolve()
}

export function flushObservability(): Promise<void> {
  return queue.catch(() => {})
}

export function runTraceKey(sessionId: string, runId: string): string {
  return `agent.turn:${sessionId}:${runId}`
}

export function bindActiveSpan(key: string, span: TraceSpan): void {
  activeSpans.set(key, span)
}

export function getActiveSpan(key: string): TraceSpan | undefined {
  return activeSpans.get(key)
}

export function clearActiveSpan(key: string, span?: TraceSpan): void {
  if (!span || activeSpans.get(key)?.id === span.id) activeSpans.delete(key)
}

export function startSpan(name: string, input: SpanInput = {}): TraceSpan {
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
    enqueue((d) => d.writeSpan(snapshot))
  }
  return span
}

/**
 * Records an already-completed span with one driver write.
 *
 * Performance probes use this instead of startSpan/endSpan so observing a
 * SQLite write does not create two extra SQLite writes of its own.
 */
export function recordCompletedSpan(name: string, input: CompletedSpanInput): TraceSpan {
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
    enqueue((d) => d.writeSpan(snapshotSpan(span)))
  }
  return span
}

export function addEvent(name: string, input: EventInput = {}): void {
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
  enqueue((d) => d.writeEvent(snapshot))
}

export function endSpan(
  span: TraceSpan | undefined,
  status: Exclude<TraceStatus, 'running'>,
  attrs?: TraceAttributesInput,
  err?: unknown,
): void {
  if (!span || span.endedAt !== undefined) return
  const endedAt = Date.now()
  span.status = status
  span.endedAt = endedAt
  span.durationMs = Math.max(0, endedAt - span.startedAt)
  const resolvedAttrs = driver ? resolveAttrs(attrs) : initialAttrs(attrs)
  if (resolvedAttrs) span.attrs = { ...(span.attrs ?? {}), ...resolvedAttrs }
  if (err !== undefined) span.error = errorMessage(err)
  if (driver) {
    const snapshot = snapshotSpan(span)
    enqueue((d) => d.writeSpan(snapshot))
  }
}

export async function withSpan<T>(
  name: string,
  input: SpanInput,
  fn: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, input)
  try {
    const value = await fn(span)
    endSpan(span, 'ok')
    return value
  } catch (err) {
    endSpan(span, err instanceof DOMException && err.name === 'AbortError' ? 'cancelled' : 'error', undefined, err)
    throw err
  }
}
