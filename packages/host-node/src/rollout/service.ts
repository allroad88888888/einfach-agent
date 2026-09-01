import { stat } from 'node:fs/promises'

import {
  decodeAgentRolloutRecord,
  type AgentRolloutAppendResult,
  type AgentRolloutDriver,
  type AgentRolloutMutationV1,
  type AgentRolloutReconcileHistoryResult,
  type AgentRolloutRecordV1,
  type AgentRolloutWarning,
} from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { createJsonlRolloutStore, type JsonlRolloutStoreOptions } from './jsonlStore'
import {
  createRolloutProjector,
  RolloutSourceError,
  type RolloutProjectorOptions,
} from './projector'
import { discoverCanonicalRolloutSources, type CanonicalRolloutSource } from './sourceCatalog'
import {
  validateRolloutSource,
  type RolloutSourceValidationOptions,
  type RolloutSourceValidationState,
} from './sourcePreflight'

export interface NodeAgentRolloutDriverOptions {
  readonly appDataDirectory: string
  readonly executor: SqlExecutor
  readonly store?: JsonlRolloutStoreOptions
  readonly projector?: RolloutProjectorOptions
  readonly sourceValidation?: Pick<RolloutSourceValidationOptions, 'chunkBytes' | 'onChunkRead'>
}

interface EventRow { event_json: string }
type CanonicalSource = CanonicalRolloutSource

function warning(kind: AgentRolloutWarning['kind'], error: unknown, source?: CanonicalSource): AgentRolloutWarning {
  const location = source ? ` [history=${source.historyId} source=${source.filePath}]` : ''
  return { kind, code: kind === 'source' ? 'ROLLOUT_SOURCE_FAILED' : 'ROLLOUT_PROJECTION_FAILED',
    message: `${error instanceof Error ? error.message : String(error)}${location}` }
}

function hasErrno(error: unknown, code: string): boolean {
  let current: unknown = error
  while (current instanceof Error) {
    if ((current as NodeJS.ErrnoException).code === code) return true
    current = current.cause
  }
  return false
}

function classifiedWarning(error: unknown, source: CanonicalSource): AgentRolloutWarning {
  return warning(error instanceof RolloutSourceError ? 'source' : 'projection', error, source)
}

async function validateExistingSource(
  appDataDirectory: string,
  source: CanonicalSource,
  previous: RolloutSourceValidationState | undefined,
  options: NodeAgentRolloutDriverOptions['sourceValidation'],
): Promise<RolloutSourceValidationState | undefined> {
  try { await stat(source.filePath) } catch (error) {
    if (hasErrno(error, 'ENOENT') && !previous) return undefined
    throw new RolloutSourceError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  try { return await validateRolloutSource(appDataDirectory, source, { ...options, previous }) } catch (error) {
    throw new RolloutSourceError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

function mutationKey(mutation: AgentRolloutMutationV1): string {
  if (mutation.mutationType === 'session_meta') return 'session_meta'
  if (mutation.mutationType === 'item_upsert' || mutation.mutationType === 'item_deleted') {
    return `item:${mutation.itemId}`
  }
  return `${mutation.mutationType}:${mutation.turnId ?? ''}`
}

function recordMutation(record: AgentRolloutRecordV1): AgentRolloutMutationV1 {
  const { schemaVersion: _schema, historyId: _history, rolloutOrdinal: _ordinal,
    recordedAt: _recorded, ...mutation } = record
  return mutation
}

async function dedupeMutations(
  executor: SqlExecutor,
  historyId: string,
  mutations: readonly AgentRolloutMutationV1[],
): Promise<readonly AgentRolloutMutationV1[]> {
  const rows = await executor.select<EventRow[]>(
    `SELECT event_json FROM agent_rollout_events WHERE history_id=$1 ORDER BY rollout_ordinal`, [historyId],
  )
  const state = new Map<string, string>()
  for (const row of rows) {
    const mutation = recordMutation(decodeAgentRolloutRecord(row.event_json))
    state.set(mutationKey(mutation), JSON.stringify(mutation))
  }
  const kept: AgentRolloutMutationV1[] = []
  for (const mutation of mutations) {
    const key = mutationKey(mutation)
    const encoded = JSON.stringify(mutation)
    if (state.get(key) !== encoded) kept.push(mutation)
    state.set(key, encoded)
  }
  return kept
}

/** Composes the durable JSONL source with its rebuildable SQLite projection. */
export function createNodeAgentRolloutDriver(options: NodeAgentRolloutDriverOptions): AgentRolloutDriver {
  const store = createJsonlRolloutStore(options.appDataDirectory, options.store)
  const projector = createRolloutProjector(options.executor, options.projector)
  const validatedSources = new Map<string, RolloutSourceValidationState>()
  let tail: Promise<void> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = tail.then(operation)
    tail = current.then(() => undefined, () => undefined)
    return current
  }

  return {
    append(target, mutations): Promise<AgentRolloutAppendResult> {
      return enqueue(async () => {
        const result = await store.appendPrepared(target, async (source) => {
          const canonical = { filePath: source.filePath, historyId: source.historyId }
          const afterAppend = async (): Promise<AgentRolloutWarning | undefined> => {
            let validated: RolloutSourceValidationState
            try {
              validated = await validateRolloutSource(options.appDataDirectory, canonical, {
                ...options.sourceValidation, previous: validatedSources.get(source.filePath),
              })
            } catch (error) {
              throw new RolloutSourceError(error instanceof Error ? error.message : String(error), { cause: error })
            }
            validatedSources.set(source.filePath, validated)
            try {
              const projected = await projector.reconcileHistory(source.filePath)
              if (projected.historyId && projected.historyId !== source.historyId) {
                throw new RolloutSourceError(`rollout source identity mismatch: ${projected.historyId}`)
              }
              if (projected.warning?.kind === 'source') throw new RolloutSourceError(projected.warning.message)
              return projected.warning
            } catch (error) {
              if (error instanceof RolloutSourceError) throw error
              return warning('projection', error, canonical)
            }
          }
          try {
            const validated = await validateExistingSource(options.appDataDirectory, canonical,
              validatedSources.get(source.filePath), options.sourceValidation)
            if (validated) validatedSources.set(source.filePath, validated)
            else validatedSources.delete(source.filePath)
            try { await projector.reconcileHistory(source.filePath) } catch (error) {
              if (error instanceof RolloutSourceError && hasErrno(error, 'ENOENT')) {
                // The projector has initialized schema; no source is normal on first append.
              } else if (error instanceof RolloutSourceError) {
                throw error
              } else {
                return { mutations, projectionWarning: warning('projection', error, canonical), afterAppend }
              }
            }
            try {
              return { mutations: await dedupeMutations(options.executor, source.historyId, mutations), afterAppend }
            } catch (error) {
              return { mutations, projectionWarning: warning('projection', error, canonical), afterAppend }
            }
          } catch (error) {
            throw error
          }
        })
        return result
      })
    },
    reconcile() {
      return enqueue(async () => {
        const histories: AgentRolloutReconcileHistoryResult[] = []
        for (const source of await discoverCanonicalRolloutSources(options.appDataDirectory)) {
          try {
            try {
              const validated = await validateRolloutSource(options.appDataDirectory, source,
                options.sourceValidation)
              validatedSources.set(source.filePath, validated)
            } catch (error) {
              throw new RolloutSourceError(error instanceof Error ? error.message : String(error), { cause: error })
            }
            const projected = await projector.reconcileHistory(source.filePath)
            if (projected.historyId && projected.historyId !== source.historyId) {
              throw new RolloutSourceError(`rollout source identity mismatch: ${projected.historyId}`)
            }
            histories.push({ ...projected, historyId: source.historyId })
          } catch (error) {
            histories.push({ historyId: source.historyId, recordsApplied: 0, nextByteOffset: 0,
              warning: classifiedWarning(error, source) })
          }
        }
        return { histories }
      })
    },
    async flush() {
      await tail
      await store.flush()
    },
  }
}
