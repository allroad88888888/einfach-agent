import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createLegacyChildHistoryAdapter,
  LEGACY_CHILD_MAX_DIRECTORY_ENTRIES,
  LEGACY_CHILD_TRACE_MAX_BYTES,
} from './legacyChildHistory'
import { normalizeLegacyArchiveSegment } from './legacyChildPath'

let roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))
const trace = (item: unknown, timestamp = '2026-09-01T00:00:00.000Z') => JSON.stringify({ timestamp, turn: 1, item })

async function fixture(lines: string[], conversationId = 'conversation', runId = 'run') {
  const root = await mkdtemp(join(tmpdir(), 'legacy-history-')); roots.push(root)
  const archiveBasePath = `.webAgent-archive/conversations/${normalizeLegacyArchiveSegment(conversationId)}`
    + `/runs/${normalizeLegacyArchiveSegment(runId)}`
  const traceDir = join(root, archiveBasePath, 'traces')
  await mkdir(join(root, '.webAgent-archive', 'index'), { recursive: true })
  await mkdir(traceDir, { recursive: true })
  await writeFile(join(root, '.webAgent-archive/index/runs.jsonl'), `${JSON.stringify({
    archiveVersion: 1, conversationId, runId, treeId: runId, status: 'delegated', archiveBasePath,
    eventLog: `${archiveBasePath}/events.jsonl`, startedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  })}\n`)
  const tracePath = join(traceDir, 'root-01.trace.jsonl')
  await writeFile(tracePath, `${lines.join('\n')}\n`)
  return { root, traceDir, tracePath, target: { kind: 'child', conversationId, runId, agentPath: 'root-01' } as const }
}

describe('legacy child history', () => {
  it('uses the indexed normalized locator and ignores valid user/system roles', async () => {
    const seeded = await fixture([
      trace({ role: 'assistant', content: 'before needle' }), '{bad',
      trace({ role: 'user', content: 'ignored' }), trace({ role: 'system', content: 'ignored' }),
      trace({ role: 'tool', tool_call_id: 'call', content: 'after' }),
    ], 'session id', 'run id')
    const before = await readFile(seeded.tracePath, 'utf8')
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const record = await adapter.listItems(seeded.target)
    expect(record?.items.map((item) => item.role)).toEqual(['assistant', 'tool'])
    expect(record?.history.itemCount).toBe(2)
    expect(record?.warnings.filter((warning) => warning.code === 'MALFORMED_LEGACY_RECORD')).toHaveLength(1)
    const search = await adapter.search('needle', seeded.target)
    expect(search.hits).toHaveLength(1)
    expect(search.warnings.map((warning) => warning.code)).toEqual([
      'LEGACY_PARTIAL_HISTORY', 'MALFORMED_LEGACY_RECORD',
    ])
    expect((await adapter.listHistories()).records).toHaveLength(1)
    expect(await readFile(seeded.tracePath, 'utf8')).toBe(before)
  })

  it('returns a zero-record warning and continuation for a unique oversized trace', async () => {
    const seeded = await fixture([trace({ role: 'assistant', content: 'ok' })])
    await writeFile(seeded.tracePath, 'x'.repeat(LEGACY_CHILD_TRACE_MAX_BYTES + 1))
    await expect(createLegacyChildHistoryAdapter(seeded.root).listHistories()).resolves.toMatchObject({
      records: [], truncated: true, warnings: [{ code: 'OUTPUT_TRUNCATED' }],
      continuation: { lastRunAgentKey: expect.stringContaining('root-01') },
    })
  })

  it('consumes an oversized trace and resumes exclusively at the following trace', async () => {
    const seeded = await fixture([])
    await writeFile(seeded.tracePath, 'x'.repeat(LEGACY_CHILD_TRACE_MAX_BYTES + 1))
    await writeFile(join(seeded.traceDir, 'root-02.trace.jsonl'), `${trace({ role: 'assistant', content: 'later' })}\n`)
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const first = await adapter.listHistories()
    expect(first).toMatchObject({ records: [], truncated: true })
    const second = await adapter.listHistories(first.continuation)
    expect(second.records.map((record) => record.history.target)).toEqual([
      { kind: 'child', conversationId: 'conversation', runId: 'run', agentPath: 'root-02' },
    ])
    expect(second.truncated).toBe(false)
  })

  it('paginates 101 traces without duplicate or missing keys', async () => {
    const seeded = await fixture([trace({ role: 'assistant', content: 'one' })])
    for (let index = 2; index <= 101; index += 1) {
      const path = `root-${String(index).padStart(3, '0')}.trace.jsonl`
      await writeFile(join(seeded.traceDir, path), `${trace({ role: 'assistant', content: path })}\n`)
    }
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const first = await adapter.listHistories()
    const second = await adapter.listHistories(first.continuation)
    const ids = [...first.records, ...second.records].map((record) => record.history.historyId)
    expect(first.records).toHaveLength(100)
    expect(second.records).toHaveLength(1)
    expect(new Set(ids).size).toBe(101)
  })

  it('rejects a continuation after the index snapshot changes', async () => {
    const seeded = await fixture([])
    await writeFile(seeded.tracePath, 'x'.repeat(LEGACY_CHILD_TRACE_MAX_BYTES + 1))
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const first = await adapter.listHistories()
    await writeFile(join(seeded.root, '.webAgent-archive/index/runs.jsonl'), '{}\n', { flag: 'a' })
    await expect(adapter.listHistories(first.continuation)).rejects.toMatchObject({ code: 'AGENT_HISTORY_CURSOR_STALE' })
  })

  it('preserves zero-hit truncation and continuation through untargeted search', async () => {
    const seeded = await fixture([])
    await writeFile(seeded.tracePath, 'x'.repeat(LEGACY_CHILD_TRACE_MAX_BYTES + 1))
    await writeFile(join(seeded.traceDir, 'root-02.trace.jsonl'), `${trace({ role: 'assistant', content: 'needle' })}\n`)
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const result = await adapter.search('needle')
    expect(result).toMatchObject({ hits: [], truncated: true,
      warnings: [expect.objectContaining({ code: 'OUTPUT_TRUNCATED' })], continuation: expect.any(Object) })
    const resumed = await adapter.search('needle', undefined, result.continuation)
    expect(resumed.hits).toHaveLength(1)
    expect(resumed.truncated).toBe(false)
  })

  it('resumes a 300-entry directory across bounded pages without duplicate or missing traces', async () => {
    const seeded = await fixture([])
    const expected = ['root-01']
    for (let index = 0; index < 300; index += 1) {
      const isTrace = index % 75 === 0
      const name = isTrace ? `root-${index + 100}.trace.jsonl` : `ignored-${String(index).padStart(3, '0')}`
      if (isTrace) expected.push(name.slice(0, -'.trace.jsonl'.length))
      await writeFile(join(seeded.traceDir, name), isTrace ? `${trace({ role: 'assistant', content: name })}\n` : '')
    }
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const first = await adapter.listHistories()
    const second = await adapter.listHistories(first.continuation)
    expect(first).toMatchObject({ truncated: true, continuation: { directory: { checkedOffset: 256 } } })
    expect(second.truncated).toBe(false)
    const agents = [...first.records, ...second.records].map((record) =>
      (record.history.target as { agentPath: string }).agentPath).sort()
    expect(agents).toEqual(expected.sort())
    expect(new Set(agents).size).toBe(expected.length)
  })

  it('rejects directory continuation after entries change', async () => {
    const seeded = await fixture([])
    for (let index = 0; index < LEGACY_CHILD_MAX_DIRECTORY_ENTRIES; index += 1) {
      await writeFile(join(seeded.traceDir, `ignored-${String(index).padStart(3, '0')}`), '')
    }
    const adapter = createLegacyChildHistoryAdapter(seeded.root)
    const first = await adapter.listHistories()
    await writeFile(join(seeded.traceDir, 'new-entry'), '')
    await expect(adapter.listHistories(first.continuation)).rejects.toMatchObject({ code: 'AGENT_HISTORY_CURSOR_STALE' })
  })

  it('does not discover without a bound locator or targeted-load a run absent from the index', async () => {
    await expect(createLegacyChildHistoryAdapter().listHistories()).resolves.toEqual({
      records: [], warnings: [], truncated: false,
    })
    const seeded = await fixture([])
    await expect(createLegacyChildHistoryAdapter(seeded.root).listItems({
      ...seeded.target, runId: 'not-indexed',
    })).resolves.toBeUndefined()
  })
})
