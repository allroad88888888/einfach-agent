import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { AGENT_ROLLOUT_MAX_LINE_BYTES, encodeAgentRolloutRecord } from '@einfach-agent/core/history'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveRolloutHistoryPath } from './rolloutPath'
import { discoverCanonicalRolloutSources } from './sourceCatalog'
import { preflightRolloutSources, validateRolloutSource } from './sourcePreflight'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rollout-preflight-'))
  roots.push(root)
  const appData = join(root, 'app-data')
  const target = { kind: 'root' as const, conversationId: 'conversation' }
  const source = resolveRolloutHistoryPath(appData, target)
  await mkdir(dirname(source.filePath), { recursive: true })
  const record = (ordinal: number, overrides = {}) => ({ schemaVersion: 1 as const, historyId: source.historyId,
    rolloutOrdinal: ordinal, recordedAt: '2026-09-01T00:00:00.000Z', mutationType: 'session_meta' as const,
    target, title: 'Fixture', createdAt: 1, updatedAt: 1, ...overrides })
  return { appData, source, record }
}

async function preflight(appData: string, chunkBytes?: number) {
  return preflightRolloutSources(appData, await discoverCanonicalRolloutSources(appData), chunkBytes)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('rollout source preflight', () => {
  it('counts valid sources with bounded multi-chunk reads', async () => {
    const value = await fixture()
    const text = `${encodeAgentRolloutRecord(value.record(0))}\n${encodeAgentRolloutRecord(value.record(1))}\n`
    await writeFile(value.source.filePath, text)
    await expect(preflight(value.appData, 7)).resolves.toEqual({ files: 1, bytes: Buffer.byteLength(text) })
  })

  it.each([
    ['path identity', (value: Awaited<ReturnType<typeof fixture>>) => value.record(0, {
      target: { kind: 'root', conversationId: 'other' }, historyId: 'root:wrong' })],
    ['later identity', (value: Awaited<ReturnType<typeof fixture>>) => value.record(1, { historyId: 'root:wrong' })],
    ['ordinal gap', (value: Awaited<ReturnType<typeof fixture>>) => value.record(2)],
    ['duplicate ordinal', (value: Awaited<ReturnType<typeof fixture>>) => value.record(0)],
  ])('reports %s with a byte offset', async (_name, change) => {
    const value = await fixture()
    const first = encodeAgentRolloutRecord(value.record(0))
    const records = _name === 'path identity' ? [change(value)] : [value.record(0), change(value)]
    await writeFile(value.source.filePath, `${records.map(encodeAgentRolloutRecord).join('\n')}\n`)
    await expect(preflight(value.appData)).rejects.toThrow(new RegExp(`${value.source.filePath}:`))
    if (_name !== 'path identity') await expect(preflight(value.appData)).rejects.toThrow(`:${Buffer.byteLength(first) + 1}`)
  })

  it('rejects unterminated and oversized records before projection', async () => {
    const value = await fixture()
    await writeFile(value.source.filePath, encodeAgentRolloutRecord(value.record(0)))
    await expect(preflight(value.appData)).rejects.toThrow(`${value.source.filePath}:0: unterminated`)
    await writeFile(value.source.filePath, `${'x'.repeat(AGENT_ROLLOUT_MAX_LINE_BYTES + 1)}\n`)
    await expect(preflight(value.appData, 31)).rejects.toThrow(`${value.source.filePath}:0: rollout line exceeds`)
  })

  it('validates only a cached tail and detects truncation, replacement, and corrupt tails', async () => {
    const value = await fixture()
    const canonical = { filePath: value.source.filePath, historyId: value.source.historyId }
    const first = `${encodeAgentRolloutRecord(value.record(0))}\n`
    const second = `${encodeAgentRolloutRecord(value.record(1))}\n`
    await writeFile(value.source.filePath, first)
    let bytes = 0
    const initial = await validateRolloutSource(value.appData, canonical,
      { chunkBytes: 11, onChunkRead: (count) => { bytes += count } })
    await appendFile(value.source.filePath, second)
    const extended = await validateRolloutSource(value.appData, canonical,
      { previous: initial, chunkBytes: 9, onChunkRead: (count) => { bytes += count } })
    expect(bytes).toBe(Buffer.byteLength(first + second))
    expect(extended.nextOrdinal).toBe(2)

    await appendFile(value.source.filePath, 'corrupt\n')
    await expect(validateRolloutSource(value.appData, canonical, { previous: extended }))
      .rejects.toThrow(`:${extended.byteOffset}:`)
    await truncate(value.source.filePath, extended.byteOffset - 1)
    await expect(validateRolloutSource(value.appData, canonical, { previous: extended }))
      .rejects.toThrow('source was truncated')

    const replacement = join(dirname(value.source.filePath), 'replacement.jsonl')
    await writeFile(replacement, first + second)
    await rename(replacement, value.source.filePath)
    await expect(validateRolloutSource(value.appData, canonical, { previous: extended }))
      .rejects.toThrow('source file identity changed')
    let rebuiltBytes = 0
    await validateRolloutSource(value.appData, canonical, { onChunkRead: (count) => { rebuiltBytes += count } })
    expect(rebuiltBytes).toBe(Buffer.byteLength(first + second))
  })
})
