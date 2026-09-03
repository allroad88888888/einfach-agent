import { createSqliteRecoveryReader } from '@einfach-agent/persistence-sqlite'
import type { RecoveryDriver, SqlExecutor } from '@einfach-agent/core/state/persistence'

/** History only consumes persistence's read facade; SQLite schema and row codecs stay in persistence. */
export function createHistoryRecoveryReader(executor: SqlExecutor): Pick<RecoveryDriver, 'listLatest'> {
  return createSqliteRecoveryReader(executor)
}
