// SQLite 的会话事务日志 driver。
// ---------------------------------------------------------------------------
// 每个 session 一行、整份覆盖（`INSERT ... ON CONFLICT ... DO UPDATE`，单条原子语句 ——
// 与恢复 driver 同样刻意不用 BEGIN/COMMIT，理由见 sqliteShared.ts 的连接池说明）。
//
// 与恢复 driver 的关键差别：日志**不是真相**。它靠 `generation` 与恢复快照配对，配不上就被
// 读回侧整份丢弃（见 core 的 historyLogDriver.ts）。所以坏数据在这里一律降级为「没有日志」
// 而不是上抛：撤销不可用是可接受的，把启动拖垮不是。恢复快照那侧相反，必须上抛。

import type { HistoryLogDriver, PersistedHistoryLog } from '@web-agent/core/state/persistence'
import { getDb } from './sqliteShared'

interface HistoryLogRow {
  session_id: string
  generation: number
  payload: string
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('History log sessionId must not be empty')
}

/** 行长得像一份日志吗。不像就当没有 —— 读回侧会以「没有日志」继续，状态不受影响。 */
function decodeRow(row: HistoryLogRow, sessionId: string): PersistedHistoryLog | undefined {
  if (row.session_id !== sessionId) return undefined
  if (typeof row.generation !== 'number' || !Number.isSafeInteger(row.generation)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Record<string, unknown>
  if (!Array.isArray(candidate.entries)) return undefined
  if (typeof candidate.cursor !== 'number' || !Number.isSafeInteger(candidate.cursor)) return undefined
  // generation 以列为准：它是配对判据，payload 里那份只是副本。
  return {
    generation: row.generation,
    entries: candidate.entries as PersistedHistoryLog['entries'],
    cursor: candidate.cursor,
  }
}

/** 每次工厂调用都返回独立 facade，但它们共用同一 SQLite 数据库。 */
export function createSqliteHistoryLogDriver(): HistoryLogDriver {
  return {
    async load(sessionId) {
      assertSessionId(sessionId)
      const db = await getDb()
      const rows = await db.select<HistoryLogRow[]>(
        'SELECT session_id, generation, payload FROM history_log WHERE session_id = $1',
        [sessionId],
      )
      const row = rows[0]
      return row ? decodeRow(row, sessionId) : undefined
    },

    async save(sessionId, log) {
      assertSessionId(sessionId)
      const db = await getDb()
      await db.execute(
        `INSERT INTO history_log (session_id, generation, payload) VALUES ($1, $2, $3)
           ON CONFLICT(session_id) DO UPDATE SET generation = excluded.generation, payload = excluded.payload`,
        [sessionId, log.generation, JSON.stringify(log)],
      )
    },

    async deleteSession(sessionId) {
      assertSessionId(sessionId)
      const db = await getDb()
      await db.execute('DELETE FROM history_log WHERE session_id = $1', [sessionId])
    },
  }
}
