import { createHash } from 'node:crypto'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  replayHistoryLog, validateHistoryLogBatch,
  type HistoryLogBatch, type HistoryLogDriver,
} from '@einfach-agent/core/state/persistence'
import { acquireRolloutLock } from '../rollout/rolloutLock'
import { durableAppend } from '../rollout/jsonlStore'

const MAX_LINE_BYTES = 16 * 1024 * 1024
interface JournalIndex {
  offset: number
  records: Map<string, { offset: number; bytes: number; parent: string | null; digest: string }>
}

function digest(batch: HistoryLogBatch): string {
  return createHash('sha256').update(JSON.stringify(batch)).digest('hex')
}

function checkAppend(index: JournalIndex, batch: HistoryLogBatch): 'duplicate' | 'new' {
  const previous = index.records.get(batch.id)
  if (previous) {
    if (previous.digest !== digest(batch)) throw new Error('History journal batch id conflict')
    return 'duplicate'
  }
  if (batch.parent !== null && !index.records.has(batch.parent)) throw new Error('Missing history journal parent')
  return 'new'
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose POSIX directory fsync through Node's file API.
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Reads only newly appended bytes. An incomplete final line is never acknowledged or replayed. */
async function refresh(file: FileHandle, index: JournalIndex, sessionId: string): Promise<number> {
  const size = (await file.stat()).size
  if (size < index.offset) throw new Error('History journal was truncated behind its durable head')
  let position = index.offset
  let remainder = Buffer.alloc(0)
  const buffer = Buffer.alloc(64 * 1024)
  while (position < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position)
    if (!bytesRead) throw new Error('History journal changed while reading')
    position += bytesRead
    remainder = Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
    let newline: number
    while ((newline = remainder.indexOf(10)) >= 0) {
      if (newline > MAX_LINE_BYTES) throw new Error('History journal record is too large')
      const raw = JSON.parse(remainder.subarray(0, newline).toString('utf8')) as Record<string, unknown>
      if (raw.sessionId !== sessionId) throw new Error('History journal session mismatch')
      const batch = validateHistoryLogBatch(raw.batch)
      checkAppend(index, batch)
      index.records.set(batch.id, { offset: index.offset, bytes: newline + 1, parent: batch.parent, digest: digest(batch) })
      index.offset += newline + 1
      remainder = remainder.subarray(newline + 1)
    }
    if (remainder.length > MAX_LINE_BYTES) throw new Error('History journal record is too large')
  }
  return size
}

/** Local append-only undo journal. Snapshot heads select branches; files are never rewritten wholesale. */
export function createNodeHistoryLogDriver(appDataDirectory: string): HistoryLogDriver {
  const indexes = new Map<string, JournalIndex>()
  const tails = new Map<string, Promise<unknown>>()

  function pathFor(sessionId: string): string {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('History journal sessionId must not be empty')
    return join(appDataDirectory, 'history-journals', `${createHash('sha256').update(sessionId).digest('hex')}.jsonl`)
  }

  function indexFor(sessionId: string): JournalIndex {
    let index = indexes.get(sessionId)
    if (!index) {
      index = { offset: 0, records: new Map() }
      indexes.set(sessionId, index)
    }
    return index
  }

  function serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(task, task)
    const settled = result.then(() => undefined, () => undefined)
    tails.set(sessionId, settled)
    void settled.then(() => { if (tails.get(sessionId) === settled) tails.delete(sessionId) })
    return result
  }

  return {
    append(sessionId, candidate) {
      const path = pathFor(sessionId)
      const batch = validateHistoryLogBatch(candidate)
      const line = `${JSON.stringify({ sessionId, batch })}\n`
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return Promise.reject(new Error('History journal batch is too large'))
      return serial(sessionId, async () => {
        const created = await mkdir(dirname(path), { recursive: true })
        if (created) await syncDirectory(dirname(created))
        const lock = await acquireRolloutLock(path)
        try {
          const file = await open(path, 'a+')
          const index = indexFor(sessionId)
          try {
            const size = await refresh(file, index, sessionId)
            const status = checkAppend(index, batch)
            await lock.assertOwned()
            // A crash may leave an uncommitted partial line. Preserve every complete record.
            if (size !== index.offset) await file.truncate(index.offset)
            if (status === 'new') {
              await durableAppend(path, line)
              index.records.set(batch.id, { offset: index.offset, bytes: Buffer.byteLength(line),
                parent: batch.parent, digest: digest(batch) })
              index.offset += Buffer.byteLength(line)
            } else {
              // Retrying after a lost acknowledgement must confirm durability again.
              await file.sync()
            }
          } finally { await file.close() }
          await syncDirectory(dirname(path))
        } finally { await lock.release() }
      })
    },
    load(sessionId, head) {
      const path = pathFor(sessionId)
      return serial(sessionId, async () => {
        if (head === null) return { entries: [], cursor: 0 }
        let file: FileHandle
        try { file = await open(path, 'r') } catch (error) {
          throw new Error('Missing history journal', { cause: error })
        }
        try {
          const index = indexFor(sessionId)
          await refresh(file, index, sessionId)
          // Keep only offsets in the long-lived host index, not every historical payload.
          const chain = new Map<string, HistoryLogBatch>()
          let id: string | null = head
          while (id !== null) {
            const record = index.records.get(id)
            if (!record || chain.has(id)) throw new Error('Broken history journal chain')
            const contents = Buffer.alloc(record.bytes)
            let read = 0
            while (read < contents.length) {
              const result = await file.read(contents, read, contents.length - read, record.offset + read)
              if (!result.bytesRead) throw new Error('History journal changed while reading')
              read += result.bytesRead
            }
            const raw = JSON.parse(contents.toString('utf8')) as { sessionId: string; batch: unknown }
            const batch = validateHistoryLogBatch(raw.batch)
            if (raw.sessionId !== sessionId || batch.id !== id || digest(batch) !== record.digest) {
              throw new Error('History journal identity mismatch')
            }
            chain.set(id, batch)
            id = record.parent
          }
          return replayHistoryLog(chain, head)
        } finally { await file.close() }
      })
    },
  }
}
