// Tauri SQLite trace driver：复用 sqlite:web-agent.db，本地 best-effort 写 span/event。

import Database from '@tauri-apps/plugin-sql'
import type { TraceAttributes, TraceDriver, TraceEvent, TraceSpan } from './types'

const DB_URL = 'sqlite:web-agent.db'

let dbPromise: Promise<Database> | undefined

function attrText(attrs: TraceAttributes | undefined, key: string): string | null {
  const value = attrs?.[key]
  return typeof value === 'string' ? value : null
}

async function bestEffortExecute(db: Database, sql: string): Promise<void> {
  try {
    await db.execute(sql)
  } catch {
    // 迁移/索引是 best-effort；重复列等错误不影响日志写入。
  }
}

async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load(DB_URL)
      try {
        await db.select('PRAGMA journal_mode=WAL')
        await db.select('PRAGMA busy_timeout=5000')
        await db.select('PRAGMA synchronous=NORMAL')
      } catch {
        // PRAGMA 调优失败不阻塞日志表初始化。
      }
      await db.execute(
        `CREATE TABLE IF NOT EXISTS trace_spans (
           id TEXT PRIMARY KEY,
           trace_id TEXT NOT NULL,
           session_id TEXT,
           run_id TEXT,
           turn_id TEXT,
           parent_span_id TEXT,
           name TEXT NOT NULL,
           kind TEXT NOT NULL,
           status TEXT NOT NULL,
           started_at INTEGER NOT NULL,
           ended_at INTEGER,
           duration_ms INTEGER,
           attrs TEXT,
           error TEXT
         )`,
      )
      await db.execute(
        `CREATE TABLE IF NOT EXISTS trace_events (
           id TEXT PRIMARY KEY,
           trace_id TEXT NOT NULL,
           session_id TEXT,
           run_id TEXT,
           turn_id TEXT,
           span_id TEXT,
           name TEXT NOT NULL,
           timestamp INTEGER NOT NULL,
           attrs TEXT
         )`,
      )
      await bestEffortExecute(db, 'ALTER TABLE trace_spans ADD COLUMN session_id TEXT')
      await bestEffortExecute(db, 'ALTER TABLE trace_spans ADD COLUMN run_id TEXT')
      await bestEffortExecute(db, 'ALTER TABLE trace_spans ADD COLUMN turn_id TEXT')
      await bestEffortExecute(db, 'ALTER TABLE trace_events ADD COLUMN session_id TEXT')
      await bestEffortExecute(db, 'ALTER TABLE trace_events ADD COLUMN run_id TEXT')
      await bestEffortExecute(db, 'ALTER TABLE trace_events ADD COLUMN turn_id TEXT')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON trace_spans(trace_id)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_spans_session_started ON trace_spans(session_id, started_at)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_spans_run_id ON trace_spans(run_id)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_events_trace_id ON trace_events(trace_id)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_events_session_timestamp ON trace_events(session_id, timestamp)')
      await db.execute('CREATE INDEX IF NOT EXISTS idx_trace_events_run_id ON trace_events(run_id)')
      return db
    })()
    dbPromise.catch(() => {
      dbPromise = undefined
    })
  }
  return dbPromise
}

export function __resetSqliteLogForTest(): void {
  dbPromise = undefined
}

export function createSqliteLogDriver(): TraceDriver {
  return {
    async writeSpan(span: TraceSpan): Promise<void> {
      try {
        const db = await getDb()
        await db.execute(
          `INSERT OR REPLACE INTO trace_spans
             (id, trace_id, session_id, run_id, turn_id, parent_span_id, name, kind, status, started_at, ended_at, duration_ms, attrs, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
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
          ],
        )
      } catch {
        // best-effort：日志失败不影响主流程。
      }
    },

    async writeEvent(event: TraceEvent): Promise<void> {
      try {
        const db = await getDb()
        await db.execute(
          `INSERT OR REPLACE INTO trace_events
             (id, trace_id, session_id, run_id, turn_id, span_id, name, timestamp, attrs)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            event.traceId,
            attrText(event.attrs, 'sessionId'),
            attrText(event.attrs, 'runId'),
            attrText(event.attrs, 'turnId'),
            event.spanId ?? null,
            event.name,
            event.timestamp,
            event.attrs ? JSON.stringify(event.attrs) : null,
          ],
        )
      } catch {
        // best-effort。
      }
    },
  }
}
