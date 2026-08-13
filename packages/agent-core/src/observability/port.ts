import type { PerformanceDiagnosticOperation, PerformanceDiagnosticOptions } from './performanceDiagnosticPort'
import type { SafePayloadPreviewOptions } from './redact'
import type { SpanKind, TraceAttributes, TraceSpan, TraceStatus } from './types'

/** Attributes may be evaluated only when a driver is configured. */
export type TraceAttributesInput = TraceAttributes | (() => TraceAttributes)

export interface StartSpanInput {
  kind?: SpanKind
  parent?: TraceSpan
  traceId?: string
  parentSpanId?: string
  attrs?: TraceAttributesInput
}

export interface AddEventInput {
  span?: TraceSpan
  traceId?: string
  spanId?: string
  attrs?: TraceAttributesInput
}

export interface CompletedSpanInput {
  kind?: SpanKind
  traceId?: string
  parentSpanId?: string
  startedAt: number
  endedAt: number
  status?: Exclude<TraceStatus, 'running'>
  attrs?: TraceAttributesInput
  error?: unknown
}

/** Runtime's write-only observability boundary, owned by one CoreInstance. */
export interface ObservabilityPort {
  runTraceKey(sessionId: string, runId: string): string
  bindActiveSpan(key: string, span: TraceSpan): void
  getActiveSpan(key: string): TraceSpan | undefined
  clearActiveSpan(key: string, span?: TraceSpan): void
  startSpan(name: string, input?: StartSpanInput): TraceSpan
  recordCompletedSpan(name: string, input: CompletedSpanInput): TraceSpan
  addEvent(name: string, input?: AddEventInput): void
  endSpan(
    span: TraceSpan | undefined,
    status: Exclude<TraceStatus, 'running'>,
    attrs?: TraceAttributesInput,
    error?: unknown,
  ): void
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
  previewPayload(value: unknown, limit?: number, options?: SafePayloadPreviewOptions): string
}

export type { PerformanceDiagnosticOperation, PerformanceDiagnosticOptions } from './performanceDiagnosticPort'
export type { SpanKind, TraceAttributes, TraceSpan, TraceStatus } from './types'
export type { SafePayloadPreviewOptions } from './redact'
export { createObservabilityPort, getDefaultObservabilityPort } from './trace'
