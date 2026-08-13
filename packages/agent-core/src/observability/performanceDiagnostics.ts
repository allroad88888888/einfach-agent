import { getDefaultObservabilityPort } from './port'
import type {
  PerformanceDiagnosticOperation,
  PerformanceDiagnosticOptions,
  TraceAttributes,
  TraceStatus,
} from './port'

export type { PerformanceDiagnosticOperation, PerformanceDiagnosticOptions } from './port'

/** Compatibility facade for callers outside a CoreInstance. */
export function performanceNow(): number {
  return getDefaultObservabilityPort().performanceNow()
}

export function beginPerformanceDiagnostic(
  name: string,
  attrs: TraceAttributes = {},
  options: PerformanceDiagnosticOptions = {},
): PerformanceDiagnosticOperation {
  return getDefaultObservabilityPort().beginPerformanceDiagnostic(name, attrs, options)
}

/** Records a duration observed by an external clock, such as event-loop lag. */
export function recordPerformanceDiagnostic(
  name: string,
  durationMs: number,
  attrs: TraceAttributes = {},
  options: PerformanceDiagnosticOptions = {},
): void {
  getDefaultObservabilityPort().recordPerformanceDiagnostic(name, durationMs, attrs, options)
}

export type { TraceStatus }
