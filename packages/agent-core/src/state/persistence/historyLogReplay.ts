import type { HistoryEntry, HistoryStackState } from '@einfach/core'
import type { HistoryLogBatch, HistoryLogOperation } from './historyLogDriver'

/** Reconstructs the ledger selected by a snapshot, ignoring later writes and abandoned branches. */
export function replayHistoryLog(
  records: ReadonlyMap<string, HistoryLogBatch>, head: string | null,
): HistoryStackState {
  const chain: HistoryLogBatch[] = []
  const visited = new Set<string>()
  while (head !== null) {
    const batch = records.get(head)
    if (!batch || visited.has(head)) throw new Error('Broken history journal chain')
    visited.add(head)
    chain.push(batch)
    head = batch.parent
  }
  let entries: HistoryEntry[] = []
  let cursor = 0
  function apply(op: HistoryLogOperation): void {
    if (op.type === 'append') {
      if (cursor !== entries.length) throw new Error('History append requires truncating the redo branch')
      entries.push(op.entry)
      // Einfach publishes the cursor separately, after append and possible cap eviction.
    } else if (op.type === 'dropOldest') {
      if (op.count > entries.length) throw new Error('Invalid history eviction')
      entries = entries.slice(op.count)
      cursor = Math.max(0, cursor - op.count)
    } else if (op.type === 'dropAfter') {
      if (op.cursor > entries.length) throw new Error('Invalid history branch')
      entries.length = op.cursor
      cursor = Math.min(cursor, op.cursor)
    } else {
      if (op.cursor > entries.length) throw new Error('Invalid history cursor')
      cursor = op.cursor
    }
  }
  for (const batch of chain.reverse()) for (const op of batch.operations) apply(op)
  return JSON.parse(JSON.stringify({ entries, cursor })) as HistoryStackState
}
