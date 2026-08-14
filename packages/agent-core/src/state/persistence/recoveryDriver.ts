// 中断恢复快照的持久化契约与零依赖内存实现。
// ---------------------------------------------------------------------------
// 此处只管理「每个 session 最新的一条 RecoverySnapshotV1」；它不是 HistoryDriver，不能追加
// checkpoint、更不能提供 redo。deleteSession 写入终态 tombstone，使迟到的 writer 无法复活会话。

import { decodeRecoverySnapshot } from '../recoverySnapshot.codec'
import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'

export type RecoverySaveResult =
  | { status: 'saved'; generation: number }
  | { status: 'stale'; currentGeneration: number }
  | { status: 'tombstoned' }

/** 每个 session 一条、可覆盖的中断恢复真相；与 checkpoint 历史完全独立。 */
export interface RecoveryDriver {
  listLatest(): Promise<RecoverySnapshotV1[]>
  loadLatest(sessionId: string): Promise<RecoverySnapshotV1 | undefined>
  saveLatest(sessionId: string, snapshot: RecoverySnapshotV1): Promise<RecoverySaveResult>
  /** 永久 fence 此 session；同 UUID 的任何后续 save 都必须被拒绝。 */
  deleteSession(sessionId: string): Promise<void>
}

/** 快照不是可信边界：持久化前后均强制走 JSON 往返与 v1 codec。 */
export function validateRecoverySnapshot(
  value: unknown,
  expectedSessionId?: string,
): RecoverySnapshotV1 {
  const original = decodeRecoverySnapshot(value)
  if (!original) throw new Error('Recovery snapshot failed v1 validation')
  if (expectedSessionId !== undefined && original.sessionId !== expectedSessionId) {
    throw new Error('Recovery snapshot sessionId does not match its storage key')
  }

  let parsed: unknown
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('Recovery snapshot is not JSON serializable')
    parsed = JSON.parse(json) as unknown
  } catch (error) {
    throw new Error('Recovery snapshot JSON serialization failed', { cause: error })
  }
  const snapshot = decodeRecoverySnapshot(parsed)
  if (!snapshot) throw new Error('Recovery snapshot failed v1 validation')
  if (expectedSessionId !== undefined && snapshot.sessionId !== expectedSessionId) {
    throw new Error('Recovery snapshot sessionId does not match its storage key')
  }
  return snapshot
}

function requireSessionId(sessionId: string): void {
  if (sessionId.length === 0) throw new Error('Recovery sessionId must not be empty')
}

/** 无盘宿主与契约测试使用的恢复 driver；每个工厂实例彼此隔离。 */
export function createMemoryRecoveryDriver(): RecoveryDriver {
  const snapshots = new Map<string, RecoverySnapshotV1>()
  const tombstones = new Set<string>()

  return {
    async listLatest() {
      return [...snapshots.values()].map((snapshot) => validateRecoverySnapshot(snapshot))
    },

    async loadLatest(sessionId) {
      requireSessionId(sessionId)
      const snapshot = snapshots.get(sessionId)
      return snapshot === undefined ? undefined : validateRecoverySnapshot(snapshot, sessionId)
    },

    async saveLatest(sessionId, candidate) {
      requireSessionId(sessionId)
      const snapshot = validateRecoverySnapshot(candidate, sessionId)
      if (tombstones.has(sessionId)) return { status: 'tombstoned' }
      const current = snapshots.get(sessionId)
      if (current && snapshot.generation <= current.generation) {
        return { status: 'stale', currentGeneration: current.generation }
      }
      snapshots.set(sessionId, snapshot)
      return { status: 'saved', generation: snapshot.generation }
    },

    async deleteSession(sessionId) {
      requireSessionId(sessionId)
      snapshots.delete(sessionId)
      tombstones.add(sessionId)
    },
  }
}
