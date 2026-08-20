// SQLite trace driver 的读取端：把两张表读回一份 TraceLogSnapshot（TraceViewer 的数据源）。
// ---------------------------------------------------------------------------
// P4 之后本文件不再认识任何具体 SQL 上游包：执行面由装配层经 `configureTraceSqlExecutor` 注入，
// 这里只按 `SqlExecutor` 契约用它。于是同一份读取逻辑在 server 宿主（HTTP 打到本机 Node 后端）与
// CLI（进程内 node:sqlite 执行面）上是同一段代码——「trace viewer 在 server 宿主下能读到 span」
// 因此不靠这里多一条分支，靠的是执行面被换掉。（T1 之前这里还有桌面壳注入 Tauri SQL 插件的第三条
// 执行面，已随桌面端一起删除。）
//
// 取的是 `loadTraceSqlExecutor()` 而**不是** `getTraceDb()`：后者会顺带建表并把遗留的 running
// span 收为 cancelled，而打开 TraceViewer 是只读动作（理由见 sqliteLogTransport.ts 的文件头）。
// 表还不存在时下面两条 SELECT 各自失败、各自收成空集，快照是空的但结构完整。

import { loadTraceSqlExecutor } from './sqliteLogTransport'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'
import type {
  TraceLogReader,
  TraceLogSnapshot,
  SpanKind,
  TraceAttributes,
  TraceEvent,
  TraceSpan,
  TraceStatus,
} from '@einfach-agent/core/observability'

type SpanRow = {
  id: string
  trace_id: string
  session_id?: string | null
  run_id?: string | null
  turn_id?: string | null
  parent_span_id?: string | null
  name: string
  kind: string
  status: string
  started_at: number
  ended_at?: number | null
  duration_ms?: number | null
  attrs?: string | null
  error?: string | null
}

type EventRow = {
  id: string
  trace_id: string
  session_id?: string | null
  run_id?: string | null
  turn_id?: string | null
  span_id?: string | null
  name: string
  timestamp: number
  attrs?: string | null
}

function parseAttrs(raw: string | null | undefined): TraceAttributes {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function putTextAttr(attrs: TraceAttributes, key: string, value: string | null | undefined): void {
  if (value && attrs[key] === undefined) attrs[key] = value
}

function attrsWithColumns(row: SpanRow | EventRow): TraceAttributes | undefined {
  const attrs = parseAttrs(row.attrs)
  putTextAttr(attrs, 'sessionId', row.session_id)
  putTextAttr(attrs, 'runId', row.run_id)
  putTextAttr(attrs, 'turnId', row.turn_id)
  return Object.keys(attrs).length > 0 ? attrs : undefined
}

function spanKind(value: string): SpanKind {
  return value === 'agent' || value === 'llm' || value === 'tool' || value === 'internal'
    ? value
    : 'internal'
}

function traceStatus(value: string): TraceStatus {
  return value === 'running' || value === 'ok' || value === 'error' || value === 'cancelled'
    ? value
    : 'error'
}

function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function mapSpan(row: SpanRow): TraceSpan {
  return {
    id: row.id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id ?? undefined,
    name: row.name,
    kind: spanKind(row.kind),
    status: traceStatus(row.status),
    startedAt: row.started_at,
    endedAt: optionalNumber(row.ended_at),
    durationMs: optionalNumber(row.duration_ms),
    attrs: attrsWithColumns(row),
    error: row.error ?? undefined,
  }
}

function mapEvent(row: EventRow): TraceEvent {
  return {
    id: row.id,
    traceId: row.trace_id,
    spanId: row.span_id ?? undefined,
    name: row.name,
    timestamp: row.timestamp,
    attrs: attrsWithColumns(row),
  }
}

async function readRows<T>(db: SqlExecutor, sql: string): Promise<T[]> {
  try {
    return await db.select<T[]>(sql)
  } catch {
    return []
  }
}

export function createSqliteLogReader(): TraceLogReader {
  return {
    source: 'sqlite',
    async readAll(): Promise<TraceLogSnapshot> {
      const db = await loadTraceSqlExecutor()
      const [spanRows, eventRows] = await Promise.all([
        readRows<SpanRow>(
          db,
          `SELECT id, trace_id, session_id, run_id, turn_id, parent_span_id, name, kind, status,
                  started_at, ended_at, duration_ms, attrs, error
             FROM trace_spans
            ORDER BY started_at DESC
            LIMIT 2000`,
        ),
        readRows<EventRow>(
          db,
          `SELECT id, trace_id, session_id, run_id, turn_id, span_id, name, timestamp, attrs
             FROM trace_events
            ORDER BY timestamp DESC
            LIMIT 4000`,
        ),
      ])
      return {
        source: 'sqlite',
        loadedAt: Date.now(),
        spans: spanRows.map(mapSpan),
        events: eventRows.map(mapEvent),
      }
    },
  }
}
