// SQLite 的单 session 中断恢复 driver。
// ---------------------------------------------------------------------------
// tauri-plugin-sql 背后是连接池，故这里刻意不用 BEGIN/COMMIT。条件 UPSERT 和 tombstone 各是一条
// SQLite 原子语句；失败一律上抛，不能把中断恢复误降级为「没有快照」。
//
// P1 抽出 SqlExecutor port 之后这条前提只增不减：执行面由装配层注入，本文件更没有理由假设两次
// 调用落在同一条连接上。port 因此只有「执行一条语句」而没有「执行一批语句」——把批量做成一等
// 概念等于把这个假设重新引进来，判据见 core 的 state/persistence/sqlTransport.ts 文件头。

import {
  type RecoveryDriver,
  type RecoverySaveResult,
  type RecoverySnapshotV1,
  validateRecoverySnapshot,
} from '@einfach-agent/core/state/persistence'
import { getDb } from './sqliteShared'

interface RecoveryRow {
  session_id: string
  generation: number
  deleted: number
  snapshot: string | null
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('Recovery sessionId must not be empty')
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function decodeRow(row: RecoveryRow, sessionId: string): RecoverySnapshotV1 | undefined {
  if (row.session_id !== sessionId || !isGeneration(row.generation)) {
    throw new Error('Corrupt SQLite recovery record')
  }
  if (row.deleted === 1 && row.snapshot === null) return undefined
  if (row.deleted !== 0 || row.snapshot === null) throw new Error('Corrupt SQLite recovery record')
  let raw: unknown
  try {
    raw = JSON.parse(row.snapshot) as unknown
  } catch (error) {
    throw new Error('Corrupt SQLite recovery JSON', { cause: error })
  }
  const snapshot = validateRecoverySnapshot(raw, sessionId)
  if (snapshot.generation !== row.generation) throw new Error('SQLite recovery generation mismatch')
  return snapshot
}

async function loadRow(sessionId: string): Promise<RecoveryRow | undefined> {
  const db = await getDb()
  const rows = await db.select<RecoveryRow[]>(
    'SELECT session_id, generation, deleted, snapshot FROM recovery_snapshots WHERE session_id = $1',
    [sessionId],
  )
  return rows[0]
}

/** 每次工厂调用都返回独立 facade，但它们共用同一 SQLite 数据库。 */
export function createSqliteRecoveryDriver(): RecoveryDriver {
  return {
    async listLatest() {
      const db = await getDb()
      const rows = await db.select<RecoveryRow[]>(
        'SELECT session_id, generation, deleted, snapshot FROM recovery_snapshots',
      )
      return rows.map((row) => decodeRow(row, row.session_id)).filter(
        (snapshot): snapshot is RecoverySnapshotV1 => snapshot !== undefined,
      )
    },

    async loadLatest(sessionId) {
      assertSessionId(sessionId)
      const row = await loadRow(sessionId)
      return row === undefined ? undefined : decodeRow(row, sessionId)
    },

    async saveLatest(sessionId, candidate) {
      assertSessionId(sessionId)
      const snapshot = validateRecoverySnapshot(candidate, sessionId)
      const snapshotJson = JSON.stringify(snapshot)
      const db = await getDb()
      const result = await db.execute(
        `INSERT INTO recovery_snapshots (session_id, generation, deleted, snapshot)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT(session_id) DO UPDATE SET
           generation = excluded.generation,
           deleted = 0,
           snapshot = excluded.snapshot
         WHERE excluded.generation > recovery_snapshots.generation
           AND recovery_snapshots.deleted = 0`,
        [sessionId, snapshot.generation, snapshotJson],
      )
      if (result.rowsAffected === 1) return { status: 'saved', generation: snapshot.generation }

      // 这次读取仅给拒绝结果做诊断；写入的线性化点仍是上面的单条 UPSERT。
      const current = await loadRow(sessionId)
      if (!current) throw new Error('SQLite recovery record disappeared after conditional write')
      const currentSnapshot = decodeRow(current, sessionId)
      if (!currentSnapshot) return { status: 'tombstoned' }
      return { status: 'stale', currentGeneration: currentSnapshot.generation }
    },

    async deleteSession(sessionId) {
      assertSessionId(sessionId)
      const db = await getDb()
      await db.execute(
        `INSERT INTO recovery_snapshots (session_id, generation, deleted, snapshot)
         VALUES ($1, 0, 1, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           generation = recovery_snapshots.generation,
           deleted = 1,
           snapshot = NULL`,
        [sessionId],
      )
    },
  }
}
