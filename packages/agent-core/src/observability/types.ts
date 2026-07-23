// agentNew 本地 observability 的轻量线协议。
// ---------------------------------------------------------------------------
// 只记录 metadata，不承诺外部 exporter 兼容；driver 负责 best-effort 落盘，runtime 只发旁路事件。

export type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled'

export type SpanKind = 'agent' | 'llm' | 'tool' | 'internal'

export type TraceAttributes = Record<string, unknown>

export interface TraceSpan {
  id: string
  traceId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  status: TraceStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  attrs?: TraceAttributes
  error?: string
}

export interface TraceEvent {
  id: string
  traceId: string
  spanId?: string
  name: string
  timestamp: number
  attrs?: TraceAttributes
}

export interface TraceDriver {
  writeSpan(span: TraceSpan): Promise<void>
  writeEvent(event: TraceEvent): Promise<void>
}
