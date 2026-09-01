import { validateRecoverySnapshot, type RecoveryDriver, type RecoverySnapshotV1,
  type SqlExecutor } from '@einfach-agent/core/state/persistence'

interface RecoveryRow { session_id: unknown; generation: unknown; deleted: unknown; snapshot: unknown }

/** Read-only recovery facade using the host's already-selected persistence executor. */
export function createHistoryRecoveryReader(executor: SqlExecutor): Pick<RecoveryDriver, 'listLatest'> {
  return {
    async listLatest(): Promise<RecoverySnapshotV1[]> {
      const rows = await executor.select<RecoveryRow[]>(
        'SELECT session_id, generation, deleted, snapshot FROM recovery_snapshots',
      )
      return rows.flatMap((row) => {
        if (typeof row.session_id !== 'string' || !Number.isSafeInteger(row.generation)
          || (row.generation as number) < 0) throw new Error('Corrupt SQLite recovery record')
        if (row.deleted === 1 && row.snapshot === null) return []
        if (row.deleted !== 0 || typeof row.snapshot !== 'string') throw new Error('Corrupt SQLite recovery record')
        let raw: unknown
        try { raw = JSON.parse(row.snapshot) } catch (cause) {
          throw new Error('Corrupt SQLite recovery JSON', { cause })
        }
        const snapshot = validateRecoverySnapshot(raw, row.session_id)
        if (snapshot.generation !== row.generation) throw new Error('SQLite recovery generation mismatch')
        return [snapshot]
      })
    },
  }
}
