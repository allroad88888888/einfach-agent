import type { History, Store } from '@einfach/core'
import {
  toPersistableHistoryLog,
  type HistoryLogDriver,
} from '../state/persistence/historyLogDriver'
import { readUndoBarrier } from '../state/undoBarrier'
import type { RecoveryWriteOutcome } from './recoveryWriter'

export interface PersistedHistoryLogFlushOptions {
  historyLog?: HistoryLogDriver
  historyFor?: (sessionId: string) => History | undefined
  recoveryStore?: (sessionId: string) => Store | undefined
}

/** Best-effort flush of the undo ledger paired to a successfully saved recovery generation. */
export function flushPersistedHistoryLog(
  options: PersistedHistoryLogFlushOptions,
  outcome: RecoveryWriteOutcome | undefined,
  sessionId: string,
): void {
  if (outcome?.status !== 'saved') return
  const history = options.historyFor?.(sessionId)
  if (!options.historyLog || !history) return
  const store = options.recoveryStore?.(sessionId)
  const log = toPersistableHistoryLog(
    outcome.generation,
    history.getState(),
    store ? readUndoBarrier({ store, history }) : undefined,
  )
  if (log) void options.historyLog.save(sessionId, log).catch(() => undefined)
}
