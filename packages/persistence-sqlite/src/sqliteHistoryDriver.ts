// Ta-2 · SQLite HistoryDriver 实现（拆分自 sqliteDriver.ts，T5）—— checkpoints 表的读写。
// 与 IndexedDB 版契约对齐：全 async、best-effort —— 底层报错时读退化为 []/undefined、写静默返回，
// 绝不抛（对齐 indexedDbDriver / sessionsPersistence 的降级语义，DK2）。
//
// 表结构（items/plan/recovery 等存 JSON 文本）：
//   checkpoints(session_id TEXT, turn_index INTEGER, label TEXT, kind TEXT, finish_reason TEXT,
//               created_at INTEGER, items TEXT, plan TEXT, recovery TEXT,
//               plan_stage_checkpoints TEXT, context_checkpoint TEXT,
//               PRIMARY KEY(session_id, turn_index))
//
// db 连接（getDb，含 PRAGMA 调优与建表）与 sqliteSessionsPersistence.ts 共享，定义在 sqliteShared.ts。

import type {
  CheckpointFinishReason,
  CheckpointKind,
  HistoryDriver,
} from '@web-agent/core/state/persistence'
import { beginPerformanceDiagnostic, performanceNow } from '@web-agent/core/observability'
import { getDb } from './sqliteShared'

// checkpoints 表里一行的形状（select 回来的原始行）。
interface CheckpointRow {
  turn_index: number
  label: string
  kind?: CheckpointKind | null
  finish_reason?: CheckpointFinishReason | null
  created_at: number
  items: string
  plan?: string | null
  recovery?: string | null
  plan_stage_checkpoints?: string | null
  context_checkpoint?: string | null
}

export const sqliteHistoryDriver: HistoryDriver = {
  async listCheckpoints(sessionId) {
    try {
      const db = await getDb()
      const rows = await db.select<CheckpointRow[]>(
        'SELECT turn_index, label, created_at FROM checkpoints WHERE session_id = $1 ORDER BY turn_index',
        [sessionId],
      )
      return rows.map((r) => ({ turnIndex: r.turn_index, label: r.label, createdAt: r.created_at }))
    } catch {
      return []
    }
  },

  async loadCheckpoint(sessionId, turnIndex) {
    try {
      const db = await getDb()
      const rows = await db.select<CheckpointRow[]>(
        'SELECT turn_index, label, kind, finish_reason, created_at, items, plan, recovery, plan_stage_checkpoints, context_checkpoint FROM checkpoints WHERE session_id = $1 AND turn_index = $2',
        [sessionId, turnIndex],
      )
      const row = rows[0]
      if (!row) return undefined
      return {
        turnIndex: row.turn_index,
        label: row.label,
        kind: row.kind ?? undefined,
        finishReason: row.finish_reason ?? undefined,
        createdAt: row.created_at,
        items: JSON.parse(row.items),
        plan: row.plan ? JSON.parse(row.plan) : undefined,
        recovery: row.recovery ? JSON.parse(row.recovery) : undefined,
        planStageCheckpoints: row.plan_stage_checkpoints
          ? JSON.parse(row.plan_stage_checkpoints)
          : undefined,
        contextCheckpoint: row.context_checkpoint ? JSON.parse(row.context_checkpoint) : undefined,
      }
    } catch {
      return undefined
    }
  },

  async saveCheckpoint(sessionId, checkpoint) {
    const operation = beginPerformanceDiagnostic(
      'persistence.sqlite.checkpoint',
      {
        sessionId,
        turnIndex: checkpoint.turnIndex,
        itemCount: checkpoint.items.length,
        hasPlan: checkpoint.plan !== undefined,
        planStageCount: checkpoint.plan?.stages.length ?? 0,
        hasRecovery: checkpoint.recovery !== undefined,
      },
      { slowMs: 100 },
    )
    let dbReadyMs = 0
    let serializeMs = 0
    let executeMs = 0
    let itemJsonChars = 0
    let planJsonChars = 0
    let recoveryJsonChars = 0
    try {
      let phaseStartedAt = performanceNow()
      const db = await getDb()
      dbReadyMs = performanceNow() - phaseStartedAt
      phaseStartedAt = performanceNow()
      const itemsJson = JSON.stringify(checkpoint.items)
      const planJson = checkpoint.plan === undefined ? null : JSON.stringify(checkpoint.plan)
      const recoveryJson = checkpoint.recovery === undefined ? null : JSON.stringify(checkpoint.recovery)
      const planStageCheckpointsJson = checkpoint.planStageCheckpoints === undefined
        ? null
        : JSON.stringify(checkpoint.planStageCheckpoints)
      const contextCheckpointJson = checkpoint.contextCheckpoint === undefined
        ? null
        : JSON.stringify(checkpoint.contextCheckpoint)
      serializeMs = performanceNow() - phaseStartedAt
      itemJsonChars = itemsJson.length
      planJsonChars = planJson?.length ?? 0
      recoveryJsonChars = recoveryJson?.length ?? 0
      phaseStartedAt = performanceNow()
      await db.execute(
        `INSERT OR REPLACE INTO checkpoints (session_id, turn_index, label, kind, finish_reason, created_at, items, plan, recovery, plan_stage_checkpoints, context_checkpoint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          sessionId,
          checkpoint.turnIndex,
          checkpoint.label,
          checkpoint.kind ?? null,
          checkpoint.finishReason ?? null,
          checkpoint.createdAt,
          itemsJson,
          planJson,
          recoveryJson,
          planStageCheckpointsJson,
          contextCheckpointJson,
        ],
      )
      executeMs = performanceNow() - phaseStartedAt
      operation.finish('ok', {
        dbReadyMs,
        serializeMs,
        executeMs,
        itemJsonChars,
        planJsonChars,
        recoveryJsonChars,
      })
    } catch (error) {
      operation.finish(
        'error',
        { dbReadyMs, serializeMs, executeMs, itemJsonChars, planJsonChars, recoveryJsonChars },
        error,
      )
      // best-effort：落盘失败不抛（DK2）。
    }
  },

  async truncateAfter(sessionId, turnIndex) {
    try {
      const db = await getDb()
      await db.execute('DELETE FROM checkpoints WHERE session_id = $1 AND turn_index > $2', [
        sessionId,
        turnIndex,
      ])
    } catch {
      // best-effort。
    }
  },

  async deleteSession(sessionId) {
    try {
      const db = await getDb()
      await db.execute('DELETE FROM checkpoints WHERE session_id = $1', [sessionId])
    } catch {
      // best-effort。
    }
  },
}
