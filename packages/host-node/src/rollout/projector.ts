import { open } from 'node:fs/promises'

import {
  decodeAgentRolloutRecord,
  AGENT_ROLLOUT_MAX_LINE_BYTES,
  type AgentHistoryTarget,
  type AgentRolloutRecordV1,
  type AgentRolloutReconcileHistoryResult,
} from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { ensureRolloutProjectionSchema } from './projectionSchema'

export interface RolloutProjectorOptions {
  /** Test/fault-injection seam at the exact crash boundary. */
  readonly afterRecordUpsert?: (record: AgentRolloutRecordV1) => void | Promise<void>
  /** Test seam executed inside the source-I/O classification boundary. */
  readonly beforeSourceRead?: (sourcePath: string) => void | Promise<void>
  readonly readChunkBytes?: number
}

export interface RolloutProjector {
  reconcileHistory(sourcePath: string): Promise<AgentRolloutReconcileHistoryResult>
}

export class RolloutSourceError extends Error {
  override readonly name = 'RolloutSourceError'
  constructor(message: string, options?: ErrorOptions) { super(message, options) }
}

export class RolloutProjectionError extends Error {
  override readonly name = 'RolloutProjectionError'
  constructor(message: string, options?: ErrorOptions) { super(message, options) }
}

function detail(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function sourceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof RolloutSourceError) throw error
    throw new RolloutSourceError(detail(error), { cause: error })
  }
}

async function projectionOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof RolloutProjectionError) throw error
    throw new RolloutProjectionError(detail(error), { cause: error })
  }
}

function sourceInvariant(operation: () => void): void {
  try { operation() } catch (error) {
    if (error instanceof RolloutSourceError) throw error
    throw new RolloutSourceError(detail(error), { cause: error })
  }
}

interface ProjectionStateRow {
  history_id: string
  next_byte_offset: number
  next_rollout_ordinal: number
}

interface CatalogIdentityRow {
  history_id: string
  target_kind: 'root' | 'child'
  conversation_id: string
  run_id: string | null
  agent_path: string | null
}

interface SourceIdentity {
  readonly historyId: string
  readonly target: AgentHistoryTarget
}

function catalogParams(record: AgentRolloutRecordV1): unknown[] {
  const target = record.target
  return [record.historyId, target.kind, target.conversationId,
    target.kind === 'child' ? target.runId : null,
    target.kind === 'child' ? target.agentPath : null,
    record.recordedAt, record.rolloutOrdinal]
}

async function upsertCatalog(executor: SqlExecutor, record: AgentRolloutRecordV1): Promise<void> {
  await executor.execute(
    `INSERT INTO agent_rollout_catalog
      (history_id,target_kind,conversation_id,run_id,agent_path,first_recorded_at,last_recorded_at,last_rollout_ordinal)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7)
     ON CONFLICT(history_id) DO UPDATE SET
      last_recorded_at=CASE WHEN excluded.last_rollout_ordinal >= last_rollout_ordinal THEN excluded.last_recorded_at ELSE last_recorded_at END,
      last_rollout_ordinal=MAX(last_rollout_ordinal,excluded.last_rollout_ordinal)`,
    catalogParams(record),
  )
}

async function applyMutation(executor: SqlExecutor, record: AgentRolloutRecordV1): Promise<void> {
  if (record.mutationType === 'session_meta') {
    await executor.execute(
      `UPDATE agent_rollout_catalog SET title=$1,created_at=$2,updated_at=$3
       WHERE history_id=$4 AND last_rollout_ordinal <= $5`,
      [record.title, record.createdAt, record.updatedAt, record.historyId, record.rolloutOrdinal],
    )
  } else if (record.mutationType === 'item_upsert') {
    await executor.execute(
      `INSERT INTO agent_rollout_items
       (history_id,item_id,item_ordinal,created_at,item_json,pending,plan_stage_id,deleted,delete_reason,last_change_ordinal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8)
       ON CONFLICT(history_id,item_id) DO UPDATE SET
        item_ordinal=excluded.item_ordinal,created_at=excluded.created_at,item_json=excluded.item_json,
        pending=excluded.pending,plan_stage_id=excluded.plan_stage_id,deleted=0,delete_reason=NULL,
        last_change_ordinal=excluded.last_change_ordinal
       WHERE excluded.last_change_ordinal >= last_change_ordinal`,
      [record.historyId, record.itemId, record.itemOrdinal, record.createdAt,
        JSON.stringify(record.item), record.pending, record.planStageId, record.rolloutOrdinal],
    )
  } else if (record.mutationType === 'item_deleted') {
    await executor.execute(
      `INSERT INTO agent_rollout_items
       (history_id,item_id,deleted,delete_reason,last_change_ordinal)
       VALUES ($1,$2,1,$3,$4)
       ON CONFLICT(history_id,item_id) DO UPDATE SET deleted=1,delete_reason=excluded.delete_reason,
        last_change_ordinal=excluded.last_change_ordinal
       WHERE excluded.last_change_ordinal >= last_change_ordinal`,
      [record.historyId, record.itemId, record.reason, record.rolloutOrdinal],
    )
  } else if (record.mutationType === 'turn_context') {
    await executor.execute(
      `INSERT INTO agent_rollout_turns
       (history_id,turn_key,turn_id,item_ids_json,last_change_ordinal) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(history_id,turn_key) DO UPDATE SET turn_id=excluded.turn_id,
        item_ids_json=excluded.item_ids_json,last_change_ordinal=excluded.last_change_ordinal
       WHERE excluded.last_change_ordinal >= last_change_ordinal`,
      [record.historyId, record.turnId ?? '', record.turnId, JSON.stringify(record.itemIds), record.rolloutOrdinal],
    )
  } else {
    const turnKey = record.turnId ?? ''
    await executor.execute(
      `INSERT INTO agent_rollout_turns
       (history_id,turn_key,turn_id,run_id,status,error,last_change_ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(history_id,turn_key) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,
        error=excluded.error,last_change_ordinal=excluded.last_change_ordinal
       WHERE excluded.last_change_ordinal >= last_change_ordinal`,
      [record.historyId, turnKey, record.turnId, record.runId, record.status, record.error, record.rolloutOrdinal],
    )
    const complete = record.status === 'done' || record.status === 'stopped' || record.status === 'error'
    await executor.execute(
      'UPDATE agent_rollout_catalog SET complete=$1 WHERE history_id=$2 AND last_rollout_ordinal <= $3',
      [complete, record.historyId, record.rolloutOrdinal],
    )
  }
}

async function projectRecord(executor: SqlExecutor, record: AgentRolloutRecordV1): Promise<void> {
  await upsertCatalog(executor, record)
  await executor.execute(
    `INSERT INTO agent_rollout_events
     (history_id,rollout_ordinal,mutation_type,recorded_at,event_json) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(history_id,rollout_ordinal) DO NOTHING`,
    [record.historyId, record.rolloutOrdinal, record.mutationType, record.recordedAt, JSON.stringify(record)],
  )
  await applyMutation(executor, record)
}

async function stateFor(executor: SqlExecutor, sourcePath: string): Promise<ProjectionStateRow | undefined> {
  const rows = await executor.select<ProjectionStateRow[]>(
    `SELECT history_id,next_byte_offset,next_rollout_ordinal
     FROM agent_rollout_projection_state WHERE source_path=$1`, [sourcePath],
  )
  return rows[0]
}

function partialLineWarning(sourcePath: string, offset: number) {
  return { kind: 'source' as const, code: 'ROLLOUT_PARTIAL_LINE',
    message: `unterminated rollout JSONL line at ${sourcePath}:${offset}` }
}

function recordIdentity(record: AgentRolloutRecordV1): SourceIdentity {
  return { historyId: record.historyId, target: record.target }
}

function sameTarget(left: AgentHistoryTarget, right: AgentHistoryTarget): boolean {
  return left.kind === right.kind
    && left.conversationId === right.conversationId
    && (left.kind === 'root' || (right.kind === 'child'
      && left.runId === right.runId && left.agentPath === right.agentPath))
}

function assertIdentity(identity: SourceIdentity, record: AgentRolloutRecordV1, sourcePath: string, offset: number): void {
  if (record.historyId !== identity.historyId || !sameTarget(record.target, identity.target)) {
    throw new Error(`rollout source identity changed at ${sourcePath}:${offset}`)
  }
}

async function identityFor(executor: SqlExecutor, state: ProjectionStateRow | undefined): Promise<SourceIdentity | undefined> {
  if (!state) return undefined
  const rows = await executor.select<CatalogIdentityRow[]>(
    `SELECT history_id,target_kind,conversation_id,run_id,agent_path
     FROM agent_rollout_catalog WHERE history_id=$1`, [state.history_id],
  )
  const row = rows[0]
  if (!row) throw new Error(`rollout projection state has no catalog identity: ${state.history_id}`)
  const target: AgentHistoryTarget = row.target_kind === 'root'
    ? { kind: 'root', conversationId: row.conversation_id }
    : { kind: 'child', conversationId: row.conversation_id,
      runId: row.run_id ?? '', agentPath: row.agent_path ?? '' }
  if (target.kind === 'child' && (!row.run_id || !row.agent_path)) {
    throw new Error(`rollout catalog has incomplete child identity: ${state.history_id}`)
  }
  return { historyId: state.history_id, target }
}

/** Builds an idempotent, restartable projection from one append-only JSONL history. */
export function createRolloutProjector(executor: SqlExecutor, options: RolloutProjectorOptions = {}): RolloutProjector {
  const chunkBytes = options.readChunkBytes ?? 64 * 1024
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > AGENT_ROLLOUT_MAX_LINE_BYTES) {
    throw new Error('rollout projector readChunkBytes is invalid')
  }
  return {
    async reconcileHistory(sourcePath) {
      await projectionOperation(() => ensureRolloutProjectionSchema(executor))
      const state = await projectionOperation(() => stateFor(executor, sourcePath))
      const start = state?.next_byte_offset ?? 0
      await sourceOperation(async () => { await options.beforeSourceRead?.(sourcePath) })
      const handle = await sourceOperation(() => open(sourcePath, 'r'))
      const size = (await sourceOperation(() => handle.stat())).size
      if (start > size) {
        await handle.close()
        throw new RolloutSourceError(`rollout projection offset beyond source: ${sourcePath}:${start}`)
      }
      let offset = start
      let applied = 0
      let identity = await projectionOperation(() => identityFor(executor, state))
      let pending = Buffer.alloc(0)
      let position = start
      try {
        while (position < size) {
          const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, size - position))
          const { bytesRead } = await sourceOperation(() => handle.read(chunk, 0, chunk.length, position))
          if (bytesRead === 0) break
          position += bytesRead
          pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          let newline = pending.indexOf(0x0a)
          while (newline >= 0) {
            if (newline > AGENT_ROLLOUT_MAX_LINE_BYTES) {
              throw new RolloutSourceError(`rollout line exceeds maximum size at ${sourcePath}:${offset}`)
            }
            const line = pending.subarray(0, newline)
            let record!: AgentRolloutRecordV1
            sourceInvariant(() => { record = decodeAgentRolloutRecord(line.toString('utf8')) })
            identity ??= recordIdentity(record)
            sourceInvariant(() => { assertIdentity(identity!, record, sourcePath, offset) })
            const expected = (state?.next_rollout_ordinal ?? 0) + applied
            if (record.rolloutOrdinal !== expected) {
              throw new RolloutSourceError(`unexpected rollout ordinal at ${sourcePath}:${offset}: expected ${expected}, got ${record.rolloutOrdinal}`)
            }
            await projectionOperation(() => projectRecord(executor, record))
            await projectionOperation(async () => { await options.afterRecordUpsert?.(record) })
            const nextOffset = offset + newline + 1
            await projectionOperation(() => executor.execute(
              `INSERT INTO agent_rollout_projection_state
               (source_path,history_id,next_byte_offset,next_rollout_ordinal) VALUES ($1,$2,$3,$4)
               ON CONFLICT(source_path) DO UPDATE SET next_byte_offset=excluded.next_byte_offset,
                next_rollout_ordinal=excluded.next_rollout_ordinal WHERE history_id=excluded.history_id`,
              [sourcePath, identity!.historyId, nextOffset, record.rolloutOrdinal + 1],
            ))
            offset = nextOffset
            applied += 1
            pending = pending.subarray(newline + 1)
            newline = pending.indexOf(0x0a)
          }
          if (pending.length > AGENT_ROLLOUT_MAX_LINE_BYTES) {
            throw new RolloutSourceError(`rollout line exceeds maximum size at ${sourcePath}:${offset}`)
          }
        }
      } finally {
        await sourceOperation(() => handle.close())
      }
      if (pending.length > 0) {
        return { historyId: identity?.historyId ?? '', recordsApplied: applied,
          nextByteOffset: offset, warning: partialLineWarning(sourcePath, offset) }
      }
      return { historyId: identity?.historyId ?? '', recordsApplied: applied, nextByteOffset: offset }
    },
  }
}
