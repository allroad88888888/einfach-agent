import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  decodeAgentRolloutRecord,
  encodeAgentRolloutRecord,
  AGENT_ROLLOUT_MAX_LINE_BYTES,
  sameAgentHistoryTarget,
  type AgentHistoryTarget,
  type AgentRolloutAppendResult,
  type AgentRolloutMutationV1,
  type AgentRolloutRecordV1,
} from '@einfach-agent/core/history'

import { acquireRolloutLock, type RolloutLockOptions } from './rolloutLock'
import { resolveRolloutHistoryPath } from './rolloutPath'

export const MAX_ROLLOUT_APPEND_RECORDS = 1_000
export const MAX_ROLLOUT_APPEND_BYTES = 16 * 1024 * 1024

export interface JsonlRolloutStore {
  append(target: AgentHistoryTarget, mutations: readonly AgentRolloutMutationV1[]): Promise<AgentRolloutAppendResult>
  appendPrepared(target: AgentHistoryTarget, prepare: RolloutAppendPreparation): Promise<AgentRolloutAppendResult>
  flush(): Promise<void>
}

export interface PreparedRolloutAppend {
  readonly mutations: readonly AgentRolloutMutationV1[]
  readonly projectionWarning?: AgentRolloutAppendResult['projectionWarning']
  readonly afterAppend?: (
    records: readonly AgentRolloutRecordV1[],
  ) => Promise<AgentRolloutAppendResult['projectionWarning'] | undefined>
}

export type RolloutAppendPreparation = (
  source: { readonly filePath: string; readonly historyId: string },
) => Promise<PreparedRolloutAppend>

export interface JsonlRolloutStoreOptions {
  readonly lock?: RolloutLockOptions
  readonly now?: () => Date
}

async function readLastRecord(filePath: string, historyId: string): Promise<AgentRolloutRecordV1 | undefined> {
  let handle: FileHandle
  try { handle = await open(filePath, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return undefined
    const length = Math.min(size, AGENT_ROLLOUT_MAX_LINE_BYTES + 2)
    const buffer = Buffer.allocUnsafe(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, size - length + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const tail = buffer.subarray(0, bytesRead)
    if (tail.at(-1) !== 0x0a) throw new Error(`corrupt rollout history ${historyId}: unterminated JSONL record`)
    const precedingNewline = tail.lastIndexOf(0x0a, tail.length - 2)
    if (size > length && precedingNewline < 0) {
      throw new Error(`corrupt rollout history ${historyId}: last record exceeds maximum line size`)
    }
    const line = tail.subarray(precedingNewline + 1, tail.length - 1)
    if (line.length === 0) throw new Error(`corrupt rollout history ${historyId}: empty last record`)
    const record = decodeAgentRolloutRecord(line.toString('utf8'))
    if (record.historyId !== historyId) {
      throw new Error(`corrupt rollout history ${historyId}: last record belongs to ${record.historyId}`)
    }
    return record
  } finally {
    await handle.close()
  }
}

function persistedRecords(
  historyId: string,
  target: AgentHistoryTarget,
  mutations: readonly AgentRolloutMutationV1[],
  firstOrdinal: number,
  now: () => Date,
): readonly AgentRolloutRecordV1[] {
  return mutations.map((mutation, offset) => {
    if (!sameAgentHistoryTarget(mutation.target, target)) {
      throw new Error('rollout mutation target does not match append target')
    }
    return {
      ...mutation,
      schemaVersion: 1,
      historyId,
      rolloutOrdinal: firstOrdinal + offset,
      recordedAt: now().toISOString(),
    }
  })
}

async function durableAppend(filePath: string, contents: string): Promise<void> {
  const handle = await open(filePath, 'a')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Creates an append-only JSONL source store rooted in application data. */
export function createJsonlRolloutStore(
  appDataDirectory: string,
  options: JsonlRolloutStoreOptions = {},
): JsonlRolloutStore {
  const queues = new Map<string, Promise<unknown>>()
  const pending = new Map<number, Promise<unknown>>()
  const failures = new Map<number, unknown>()
  let operationId = 0
  const now = options.now ?? (() => new Date())

  function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const id = ++operationId
    const prior = queues.get(key) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    queues.set(key, current)
    pending.set(id, current)
    void current.catch((error) => { failures.set(id, error) }).finally(() => {
      pending.delete(id)
      if (queues.get(key) === current) queues.delete(key)
    })
    return current
  }

  async function appendLocked(
    target: AgentHistoryTarget,
    prepare: RolloutAppendPreparation,
  ): Promise<AgentRolloutAppendResult> {
    const { filePath, historyId } = resolveRolloutHistoryPath(appDataDirectory, target)
    await mkdir(dirname(filePath), { recursive: true })
    const lock = await acquireRolloutLock(filePath, options.lock)
    try {
      const prepared = await prepare({ filePath, historyId })
      const mutations = prepared.mutations
      if (mutations.length === 0) return { records: [], projectionWarning: prepared.projectionWarning }
      if (mutations.length > MAX_ROLLOUT_APPEND_RECORDS) {
        throw new Error(`rollout batch exceeds ${MAX_ROLLOUT_APPEND_RECORDS} records`)
      }
      const previous = await readLastRecord(filePath, historyId)
      const records = persistedRecords(historyId, target, mutations, (previous?.rolloutOrdinal ?? -1) + 1, now)
      const encoded = `${records.map(encodeAgentRolloutRecord).join('\n')}\n`
      if (Buffer.byteLength(encoded) > MAX_ROLLOUT_APPEND_BYTES) {
        throw new Error(`rollout batch exceeds ${MAX_ROLLOUT_APPEND_BYTES} bytes`)
      }
      await lock.assertOwned()
      await durableAppend(filePath, encoded)
      const finalizedWarning = await prepared.afterAppend?.(records)
      return { records, projectionWarning: prepared.projectionWarning ?? finalizedWarning }
    } finally {
      await lock.release()
    }
  }

  return {
    append(target, mutations) {
      if (mutations.length === 0) return Promise.resolve({ records: [] })
      const { filePath } = resolveRolloutHistoryPath(appDataDirectory, target)
      return enqueue(filePath, () => appendLocked(target, async () => ({ mutations })))
    },
    appendPrepared(target, prepare) {
      const { filePath } = resolveRolloutHistoryPath(appDataDirectory, target)
      return enqueue(filePath, () => appendLocked(target, prepare))
    },
    async flush() {
      const cutoff = operationId
      await Promise.allSettled([...pending].filter(([id]) => id <= cutoff).map(([, promise]) => promise))
      const coveredFailures = [...failures].filter(([id]) => id <= cutoff)
      for (const [id] of coveredFailures) failures.delete(id)
      if (coveredFailures.length === 1) throw coveredFailures[0]![1]
      if (coveredFailures.length > 1) {
        throw new AggregateError(coveredFailures.map(([, error]) => error), 'multiple rollout appends failed')
      }
    },
  }
}
