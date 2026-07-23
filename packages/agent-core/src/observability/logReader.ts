import { isTauri } from '@tauri-apps/api/core'
import { createDevSqliteLogReader } from './devSqliteLogReader'
import { createIndexedDbLogReader } from './indexedDbLogReader'
import type { TraceEvent, TraceSpan } from './types'

export type TraceLogSource = 'indexeddb' | 'sqlite'

export interface TraceLogSnapshot {
  source: TraceLogSource
  loadedAt: number
  spans: TraceSpan[]
  events: TraceEvent[]
}

export interface TraceLogReader {
  readonly source: TraceLogSource
  readAll(): Promise<TraceLogSnapshot>
}

export async function createTraceLogReader(): Promise<TraceLogReader> {
  if (isTauri()) {
    const { createSqliteLogReader } = await import('./sqliteLogReader')
    return createSqliteLogReader()
  }
  if (import.meta.env.DEV) return createDevSqliteLogReader()
  return createIndexedDbLogReader()
}
