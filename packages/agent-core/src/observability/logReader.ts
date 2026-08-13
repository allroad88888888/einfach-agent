import type { TraceEvent, TraceSpan } from './types'

export type TraceLogSource = 'indexeddb' | 'sqlite'

export interface TraceLogSnapshot {
  source: TraceLogSource
  loadedAt: number
  spans: TraceSpan[]
  events: TraceEvent[]
}

export interface TraceLogReader {
  readonly source: TraceLogSource
  readAll(): Promise<TraceLogSnapshot>
}

export type TraceLogReaderFactory = () => TraceLogReader | Promise<TraceLogReader>

let traceLogReaderFactory: TraceLogReaderFactory | undefined

/** Configures the host-owned reader used by trace presentation and recovery. */
export function configureTraceLogReader(factory: TraceLogReaderFactory): void {
  traceLogReaderFactory = factory
}

export async function createTraceLogReader(): Promise<TraceLogReader> {
  if (!traceLogReaderFactory) throw new Error('Trace log reader is not configured by the host')
  return traceLogReaderFactory()
}
