import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  normalizeLegacyArchiveSegment,
  resolveLegacyRunIndexPath,
  resolveLegacyRunLocator,
  resolveLegacyTracePath,
} from './legacyChildPath'

let roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))
const temp = async () => { const root = await mkdtemp(join(tmpdir(), 'legacy-path-')); roots.push(root); return root }

describe('legacy child path', () => {
  it('matches writer segment normalization and fixed layout', async () => {
    const root = await temp()
    const { workspaceRoot } = await resolveLegacyRunIndexPath(root)
    const conversationId = ` session / ${'x'.repeat(100)}`
    const runId = ' run id '
    const archiveBasePath = `.webAgent-archive/conversations/${normalizeLegacyArchiveSegment(conversationId)}`
      + `/runs/${normalizeLegacyArchiveSegment(runId)}`
    const run = await resolveLegacyRunLocator({ workspaceRoot, conversationId, runId, archiveBasePath })
    expect(await resolveLegacyTracePath(run, 'root-01-02', workspaceRoot))
      .toBe(join(run, 'traces', 'root-01-02.trace.jsonl'))
  })

  it('rejects locator mismatch, absolute agent path, and symlink escape', async () => {
    const root = await temp(); const outside = await temp()
    const { workspaceRoot } = await resolveLegacyRunIndexPath(root)
    await expect(resolveLegacyRunLocator({ workspaceRoot, conversationId: 'c', runId: 'r',
      archiveBasePath: '.webAgent-archive/conversations/wrong/runs/r' })).rejects.toThrow(/does not match/)
    await expect(resolveLegacyTracePath(root, '/tmp/root-01', workspaceRoot)).rejects.toThrow(/Invalid/)
    await mkdir(join(root, '.webAgent-archive'), { recursive: true })
    await symlink(outside, join(root, '.webAgent-archive', 'conversations'))
    await expect(resolveLegacyRunLocator({ workspaceRoot, conversationId: 'c', runId: 'r',
      archiveBasePath: '.webAgent-archive/conversations/c/runs/r' })).rejects.toThrow(/escapes/)
  })
})
