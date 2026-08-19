// SQLite trace driver 的写入端：把一个 span / event 落成一条 upsert。
// ---------------------------------------------------------------------------
// 「执行面从哪来」在 sqliteLogTransport.ts，「表长什么样」在 sqliteLogSchema.ts；本文件只负责
// 「一个 TraceSpan / TraceEvent 怎么变成一条 SQL」。
//
// 两个方法都是 best-effort：trace 落盘失败**不能**影响主流程（这与会话持久化的契约相反，也正是
// 两者在 Node 宿主上分成两条逻辑连接的原因，见 host-node 的 sqlite/connectionNames.ts）。

import type { TraceAttributes, TraceDriver, TraceEvent, TraceSpan } from '@einfach-agent/core/observability'
import { getTraceDb } from './sqliteLogTransport'

const INSERT_SPAN = `INSERT OR REPLACE INTO trace_spans
     (id, trace_id, session_id, run_id, turn_id, parent_span_id, name, kind, status, started_at, ended_at, duration_ms, attrs, error)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

const INSERT_EVENT = `INSERT OR REPLACE INTO trace_events
     (id, trace_id, session_id, run_id, turn_id, span_id, name, timestamp, attrs)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

/**
 * 从 attrs 里取一个字符串值提到独立列。
 *
 * 非字符串一律当没有：这三列只用于索引与筛选，塞一个 `String(value)` 进去会让「按 sessionId 查」
 * 命中一堆 `[object Object]`，而 attrs 里原样的那份仍在，读取端拿得到。
 */
function attrText(attrs: TraceAttributes | undefined, key: string): string | null {
  const value = attrs?.[key]
  return typeof value === 'string' ? value : null
}

export function createSqliteLogDriver(): TraceDriver {
  return {
    async writeSpan(span: TraceSpan): Promise<void> {
      try {
        const db = await getTraceDb()
        await db.execute(INSERT_SPAN, [
          span.id,
          span.traceId,
          attrText(span.attrs, 'sessionId'),
          attrText(span.attrs, 'runId'),
          attrText(span.attrs, 'turnId'),
          span.parentSpanId ?? null,
          span.name,
          span.kind,
          span.status,
          span.startedAt,
          span.endedAt ?? null,
          span.durationMs ?? null,
          span.attrs ? JSON.stringify(span.attrs) : null,
          span.error ?? null,
        ])
      } catch {
        // best-effort：日志失败不影响主流程。
      }
    },

    async writeEvent(event: TraceEvent): Promise<void> {
      try {
        const db = await getTraceDb()
        await db.execute(INSERT_EVENT, [
          event.id,
          event.traceId,
          attrText(event.attrs, 'sessionId'),
          attrText(event.attrs, 'runId'),
          attrText(event.attrs, 'turnId'),
          event.spanId ?? null,
          event.name,
          event.timestamp,
          event.attrs ? JSON.stringify(event.attrs) : null,
        ])
      } catch {
        // best-effort。
      }
    },
  }
}
