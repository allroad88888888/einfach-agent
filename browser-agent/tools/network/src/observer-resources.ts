import type { ObservedRecord } from './types'

export interface ObserverResources {
  readers: Set<ReadableStreamDefaultReader<Uint8Array>>
  recordCleanups: Map<ObservedRecord, Set<() => void>>
}

export function addRecordCleanup(owner: ObserverResources, record: ObservedRecord, cleanup: () => void): void {
  let cleanups = owner.recordCleanups.get(record)
  if (!cleanups) {
    cleanups = new Set()
    owner.recordCleanups.set(record, cleanups)
  }
  cleanups.add(cleanup)
}

export function removeRecordCleanup(owner: ObserverResources, record: ObservedRecord, cleanup: () => void): void {
  const cleanups = owner.recordCleanups.get(record)
  cleanups?.delete(cleanup)
  if (cleanups?.size === 0) owner.recordCleanups.delete(record)
}

export function cleanupRecord(owner: ObserverResources, record: ObservedRecord): void {
  const cleanups = owner.recordCleanups.get(record)
  if (!cleanups) return
  owner.recordCleanups.delete(record)
  for (const cleanup of cleanups) cleanup()
}

export async function readBounded(
  owner: ObserverResources,
  stream: ReadableStream<Uint8Array>,
  limit: number,
  record?: ObservedRecord,
): Promise<string> {
  const reader = stream.getReader()
  owner.readers.add(reader)
  const decoder = new TextDecoder()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  if (record) addRecordCleanup(owner, record, cancel)
  let bytesRead = 0
  let output = ''
  try {
    while (bytesRead < limit) {
      const next = await reader.read()
      if (next.done) break
      const remaining = limit - bytesRead
      const chunk = next.value.subarray(0, remaining)
      bytesRead += chunk.byteLength
      output += decoder.decode(chunk, { stream: bytesRead < limit })
      if (next.value.byteLength > remaining) break
    }
    return output + decoder.decode()
  } finally {
    owner.readers.delete(reader)
    if (record) removeRecordCleanup(owner, record, cancel)
    cancel()
    try { reader.releaseLock() } catch { /* A pending cancel may retain the lock briefly. */ }
  }
}
