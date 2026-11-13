import type { HistoryEntry, HistoryStackState } from '@einfach/core'
import { replayHistoryLog } from './historyLogReplay'

/** Immutable batches form a chain. A recovery snapshot selects one exact head, not the file tail. */
export type HistoryLogOperation =
  | { type: 'append'; entry: HistoryEntry }
  | { type: 'dropOldest'; count: number }
  | { type: 'dropAfter'; cursor: number }
  | { type: 'setCursor'; cursor: number }

export interface HistoryLogBatch {
  version: 1
  id: string
  parent: string | null
  operations: HistoryLogOperation[]
}

export interface RecoveryHistoryRef {
  head: string | null
  barrierTxId?: string
}

export interface HistoryLogDriver {
  /** Resolves only after durable append. Repeating an identical batch is idempotent. */
  append(sessionId: string, batch: HistoryLogBatch): Promise<void>
  /** Replays only the selected chain, including its cursor and redo branch. */
  load(sessionId: string, head: string | null): Promise<HistoryStackState>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function index(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function isRecoveryHistoryRef(value: unknown): value is RecoveryHistoryRef {
  return record(value) && (value.head === null || identifier(value.head))
    && (value.barrierTxId === undefined || identifier(value.barrierTxId))
    && Object.keys(value).every((key) => key === 'head' || key === 'barrierTxId')
}

function validOperation(value: unknown): value is HistoryLogOperation {
  if (!record(value)) return false
  if (value.type === 'dropOldest') return index(value.count)
  if (value.type === 'dropAfter' || value.type === 'setCursor') return index(value.cursor)
  if (value.type !== 'append' || !record(value.entry)) return false
  const entry = value.entry
  return identifier(entry.txId) && (entry.label === undefined || typeof entry.label === 'string')
    && Array.isArray(entry.ops) && entry.ops.length > 0
    && entry.ops.every((op) => record(op) && identifier(op.key)
      && (op.scope === undefined || typeof op.scope === 'string') && ('before' in op || 'after' in op))
}

export function validateHistoryLogBatch(value: unknown): HistoryLogBatch {
  const candidate: unknown = JSON.parse(JSON.stringify(value))
  if (!record(candidate) || candidate.version !== 1 || !identifier(candidate.id)
    || !(candidate.parent === null || identifier(candidate.parent)) || candidate.parent === candidate.id
    || !Array.isArray(candidate.operations) || candidate.operations.length === 0
    || !candidate.operations.every(validOperation)) throw new Error('Invalid history journal batch')
  return candidate as unknown as HistoryLogBatch
}

/** Shared idempotency and parent validation for durable providers. */
export function checkHistoryLogAppend(
  records: ReadonlyMap<string, HistoryLogBatch>, batch: HistoryLogBatch,
): 'duplicate' | 'new' {
  const previous = records.get(batch.id)
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(batch)) throw new Error('History journal batch id conflict')
    return 'duplicate'
  }
  if (batch.parent !== null && !records.has(batch.parent)) throw new Error('Missing history journal parent')
  return 'new'
}

export function createMemoryHistoryLogDriver(): HistoryLogDriver {
  const sessions = new Map<string, Map<string, HistoryLogBatch>>()
  return {
    async append(sessionId, candidate) {
      if (!sessionId) throw new Error('History journal sessionId must not be empty')
      const batch = validateHistoryLogBatch(candidate)
      const records = sessions.get(sessionId) ?? new Map<string, HistoryLogBatch>()
      checkHistoryLogAppend(records, batch)
      records.set(batch.id, batch)
      sessions.set(sessionId, records)
    },
    async load(sessionId, head) {
      return replayHistoryLog(sessions.get(sessionId) ?? new Map(), head)
    },
  }
}
