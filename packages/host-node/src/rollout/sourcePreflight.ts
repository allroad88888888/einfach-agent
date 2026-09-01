import { open, type FileHandle } from 'node:fs/promises'

import {
  AGENT_ROLLOUT_MAX_LINE_BYTES,
  decodeAgentRolloutRecord,
  type AgentRolloutRecordV1,
} from '@einfach-agent/core/history'

import { resolveRolloutHistoryPath } from './rolloutPath'
import type { CanonicalRolloutSource } from './sourceCatalog'

const PREFIX_SENTINEL_BYTES = 128

export interface RolloutSourceValidationState {
  readonly sourcePath: string
  readonly historyId: string
  readonly device: bigint
  readonly inode: bigint
  readonly byteOffset: number
  readonly nextOrdinal: number
  readonly prefixSentinel: string
}

export interface RolloutSourceValidationOptions {
  readonly previous?: RolloutSourceValidationState
  readonly chunkBytes?: number
  readonly onChunkRead?: (bytes: number, offset: number) => void
}

export interface RolloutSourcePreflightResult {
  readonly files: number
  readonly bytes: number
}

function failure(source: CanonicalRolloutSource, offset: number, detail: string): Error {
  return new Error(`corrupt rollout source at ${source.filePath}:${offset}: ${detail}`)
}

function validateRecord(
  source: CanonicalRolloutSource,
  appDataDirectory: string,
  record: AgentRolloutRecordV1,
  offset: number,
  ordinal: number,
): void {
  const expected = resolveRolloutHistoryPath(appDataDirectory, record.target)
  if (expected.filePath !== source.filePath || expected.historyId !== source.historyId || record.historyId !== source.historyId) {
    throw failure(source, offset, 'rollout source path identity mismatch')
  }
  if (record.rolloutOrdinal !== ordinal) {
    throw failure(source, offset, `unexpected rollout ordinal: expected ${ordinal}, got ${record.rolloutOrdinal}`)
  }
}

function chunkSize(value = 64 * 1024): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > AGENT_ROLLOUT_MAX_LINE_BYTES) {
    throw new Error('rollout preflight chunkBytes is invalid')
  }
  return value
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read)
    if (result.bytesRead === 0) break
    read += result.bytesRead
  }
  return buffer.subarray(0, read)
}

async function assertCachedPrefix(
  handle: FileHandle,
  source: CanonicalRolloutSource,
  previous: RolloutSourceValidationState,
): Promise<void> {
  const length = Math.min(PREFIX_SENTINEL_BYTES, previous.byteOffset)
  const actual = await readExactly(handle, previous.byteOffset - length, length)
  if (actual.toString('base64') !== previous.prefixSentinel) {
    throw failure(source, previous.byteOffset, 'validated source prefix changed')
  }
}

/** Validates either a whole canonical source or only the tail after a trusted prior state. */
export async function validateRolloutSource(
  appDataDirectory: string,
  source: CanonicalRolloutSource,
  options: RolloutSourceValidationOptions = {},
): Promise<RolloutSourceValidationState> {
  const readChunkBytes = chunkSize(options.chunkBytes)
  const previous = options.previous
  let handle: FileHandle | undefined
  let offset = previous?.byteOffset ?? 0
  try {
    handle = await open(source.filePath, 'r')
    const stats = await handle.stat({ bigint: true })
    const size = Number(stats.size)
    if (!Number.isSafeInteger(size)) throw failure(source, offset, 'source size exceeds safe integer range')
    if (previous) {
      if (previous.sourcePath !== source.filePath || previous.historyId !== source.historyId
        || previous.device !== stats.dev || previous.inode !== stats.ino) {
        throw failure(source, offset, 'source file identity changed')
      }
      if (size < previous.byteOffset) throw failure(source, offset, 'source was truncated')
      await assertCachedPrefix(handle, source, previous)
    }
    let position = offset
    let ordinal = previous?.nextOrdinal ?? 0
    let pending = Buffer.alloc(0)
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(readChunkBytes, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      options.onChunkRead?.(bytesRead, position)
      position += bytesRead
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0) {
        if (newline > AGENT_ROLLOUT_MAX_LINE_BYTES) throw failure(source, offset, 'rollout line exceeds maximum size')
        let record: AgentRolloutRecordV1
        try { record = decodeAgentRolloutRecord(pending.subarray(0, newline).toString('utf8')) } catch (error) {
          throw failure(source, offset, error instanceof Error ? error.message : String(error))
        }
        validateRecord(source, appDataDirectory, record, offset, ordinal)
        ordinal += 1
        offset += newline + 1
        pending = pending.subarray(newline + 1)
        newline = pending.indexOf(0x0a)
      }
      if (pending.byteLength > AGENT_ROLLOUT_MAX_LINE_BYTES) throw failure(source, offset, 'rollout line exceeds maximum size')
    }
    if (pending.byteLength > 0) throw failure(source, offset, 'unterminated JSONL record')
    if (ordinal === 0) throw failure(source, 0, 'source has no complete JSONL record')
    const sentinelLength = Math.min(PREFIX_SENTINEL_BYTES, offset)
    const sentinel = await readExactly(handle, offset - sentinelLength, sentinelLength)
    return { sourcePath: source.filePath, historyId: source.historyId, device: stats.dev, inode: stats.ino,
      byteOffset: offset, nextOrdinal: ordinal, prefixSentinel: sentinel.toString('base64') }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`corrupt rollout source at ${source.filePath}:`)) throw error
    throw failure(source, offset, error instanceof Error ? error.message : String(error))
  } finally { await handle?.close() }
}

/** Performs bounded full validation before explicit reconcile/rebuild and returns reusable states. */
export async function preflightRolloutSources(
  appDataDirectory: string,
  sources: readonly CanonicalRolloutSource[],
  readChunkBytes = 64 * 1024,
  onChunkRead?: RolloutSourceValidationOptions['onChunkRead'],
): Promise<RolloutSourcePreflightResult> {
  const states: RolloutSourceValidationState[] = []
  for (const source of sources) {
    states.push(await validateRolloutSource(appDataDirectory, source, { chunkBytes: readChunkBytes, onChunkRead }))
  }
  return { files: states.length, bytes: states.reduce((sum, state) => sum + state.byteOffset, 0) }
}
