import { createIndexedDbLogReader } from '@web-agent/observability-idb'
import type { TraceLogReader, TraceLogSnapshot } from '@web-agent/core/observability'

const DEV_TRACE_ENDPOINT = '/__web_agent_trace_logs'

function isTraceLogSnapshot(value: unknown): value is TraceLogSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<TraceLogSnapshot>
  return (
    (snapshot.source === 'sqlite' || snapshot.source === 'indexeddb') &&
    typeof snapshot.loadedAt === 'number' &&
    Array.isArray(snapshot.spans) &&
    Array.isArray(snapshot.events)
  )
}

export function createDevSqliteLogReader(
  fallback: TraceLogReader = createIndexedDbLogReader(),
  endpoint: string = DEV_TRACE_ENDPOINT,
  fetchImpl: typeof fetch | undefined = globalThis.fetch?.bind(globalThis),
): TraceLogReader {
  return {
    source: 'sqlite',
    async readAll(): Promise<TraceLogSnapshot> {
      if (!fetchImpl) return fallback.readAll()
      try {
        const response = await fetchImpl(endpoint, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return fallback.readAll()
        const payload = await response.json()
        return isTraceLogSnapshot(payload) ? payload : fallback.readAll()
      } catch {
        return fallback.readAll()
      }
    },
  }
}
