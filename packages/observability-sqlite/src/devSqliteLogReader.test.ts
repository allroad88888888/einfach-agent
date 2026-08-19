import { describe, expect, it, vi } from 'vitest'
import { createDevSqliteLogReader } from './devSqliteLogReader'
import type { TraceLogReader, TraceLogSnapshot } from '@einfach-agent/core/observability'

function fallbackReader(snapshot: TraceLogSnapshot): TraceLogReader {
  return {
    source: snapshot.source,
    readAll: vi.fn(async () => snapshot),
  }
}

describe('devSqliteLogReader', () => {
  it('从 dev endpoint 读取 SQLite 日志快照', async () => {
    const snapshot: TraceLogSnapshot = {
      source: 'sqlite',
      loadedAt: 100,
      spans: [
        {
          id: 'span-1',
          traceId: 'trace-1',
          name: 'agent.turn',
          kind: 'agent',
          status: 'ok',
          startedAt: 10,
        },
      ],
      events: [],
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }))
    const fallback = fallbackReader({ source: 'indexeddb', loadedAt: 0, spans: [], events: [] })

    await expect(createDevSqliteLogReader(fallback, '/trace', fetchImpl).readAll()).resolves.toEqual(snapshot)
    expect(fetchImpl).toHaveBeenCalledWith(
      '/trace',
      expect.objectContaining({
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }),
    )
    expect(fallback.readAll).not.toHaveBeenCalled()
  })

  it('dev endpoint 不可用时回退 IndexedDB reader', async () => {
    const fallbackSnapshot: TraceLogSnapshot = { source: 'indexeddb', loadedAt: 200, spans: [], events: [] }
    const fallback = fallbackReader(fallbackSnapshot)
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }))

    await expect(createDevSqliteLogReader(fallback, '/trace', fetchImpl).readAll()).resolves.toEqual(fallbackSnapshot)
    expect(fallback.readAll).toHaveBeenCalledTimes(1)
  })
})
