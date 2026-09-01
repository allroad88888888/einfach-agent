import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LEGACY_RUN_INDEX_MAX_BYTES, findLegacyRun, readLegacyChildIndex } from './legacyChildIndex'
import { normalizeLegacyArchiveSegment } from './legacyChildPath'

let roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'legacy-index-')); roots.push(value)
  await mkdir(join(value, '.webAgent-archive', 'index'), { recursive: true })
  return value
}

function record(conversationId: string, runId: string, archiveBasePath?: string): string {
  const path = archiveBasePath ?? `.webAgent-archive/conversations/${normalizeLegacyArchiveSegment(conversationId)}`
    + `/runs/${normalizeLegacyArchiveSegment(runId)}`
  return JSON.stringify({ archiveVersion: 1, conversationId, runId, treeId: runId, status: 'delegated',
    archiveBasePath: path, eventLog: `${path}/events.jsonl`, startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z' })
}

describe('legacy child index', () => {
  it('binds normalized writer locator to original logical IDs and targeted lookup', async () => {
    const workspace = await root()
    const conversationId = ` session id/${'x'.repeat(110)} `
    const runId = 'run id'
    await writeFile(join(workspace, '.webAgent-archive/index/runs.jsonl'), `${record(conversationId, runId)}\n`)
    const result = await findLegacyRun(workspace, { kind: 'child', conversationId, runId, agentPath: 'root-01' })
    expect(result.run?.runDirectory).toContain(`/conversations/${normalizeLegacyArchiveSegment(conversationId)}/runs/run_id`)
  })

  it('rejects locator mismatch and index symlink escape', async () => {
    const workspace = await root()
    await writeFile(join(workspace, '.webAgent-archive/index/runs.jsonl'), `${record('c', 'r', '.webAgent-archive/conversations/x/runs/r')}\n`)
    expect((await readLegacyChildIndex(workspace)).warnings).toHaveLength(1)
    const outside = await root()
    await rm(join(workspace, '.webAgent-archive/index'), { recursive: true })
    await symlink(join(outside, '.webAgent-archive/index'), join(workspace, '.webAgent-archive/index'))
    await expect(readLegacyChildIndex(workspace)).rejects.toThrow(/escapes/)
  })

  it('does not let a later invalid locator swallow an earlier valid record with the same key', async () => {
    const workspace = await root()
    await writeFile(join(workspace, '.webAgent-archive/index/runs.jsonl'), [
      record('c', 'r'), record('c', 'r', '.webAgent-archive/conversations/wrong/runs/r'), '',
    ].join('\n'))
    const result = await readLegacyChildIndex(workspace)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].target).toEqual({ conversationId: 'c', runId: 'r' })
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'MALFORMED_LEGACY_RECORD' })])
  })

  it('keeps a zero-record warning when the index itself is oversized', async () => {
    const workspace = await root()
    await writeFile(join(workspace, '.webAgent-archive/index/runs.jsonl'), 'x'.repeat(LEGACY_RUN_INDEX_MAX_BYTES + 1))
    await expect(readLegacyChildIndex(workspace)).resolves.toMatchObject({
      runs: [], truncated: true, warnings: [{ code: 'OUTPUT_TRUNCATED' }],
      bytesRead: LEGACY_RUN_INDEX_MAX_BYTES + 1,
    })
  })
})
