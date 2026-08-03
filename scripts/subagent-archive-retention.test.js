import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createArchiveRetentionManifest, planArchiveRetention } from './subagent-archive-retention-lib.js'

const execFileAsync = promisify(execFile)
const cli = resolve(process.cwd(), 'scripts/subagent-archive-retention.js')

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'subagent-retention-'))
  const exportParent = await mkdtemp(join(tmpdir(), 'subagent-retention-export-'))
  const runRoot = join(base, '.agent-archive', 'conversations', 'conversation', 'runs', 'run')
  await mkdir(join(runRoot, 'nodes'), { recursive: true })
  await mkdir(join(runRoot, 'results'), { recursive: true })
  await mkdir(join(runRoot, 'traces'), { recursive: true })
  await mkdir(join(runRoot, 'skills'), { recursive: true })
  await writeFile(join(runRoot, 'run.json'), `${JSON.stringify({ status: 'delegated', startedAt: '2026-01-01T00:00:00.000Z' })}\n`)
  await writeFile(join(runRoot, 'events.jsonl'), '{"event":"preserve"}\n')
  await writeFile(join(runRoot, 'tree.json'), 'tree'.repeat(100))
  await writeFile(join(runRoot, 'nodes', 'root.json'), 'node'.repeat(100))
  await writeFile(join(runRoot, 'results', 'root.result.md'), 'result'.repeat(100))
  await writeFile(join(runRoot, 'traces', 'root.trace.jsonl'), 'trace'.repeat(100))
  await writeFile(join(runRoot, 'skills', 'root.01-core.md'), 'skill'.repeat(100))
  return {
    base,
    exportPath: join(exportParent, 'bundle'),
    runRoot,
    events: await readFile(join(runRoot, 'events.jsonl'), 'utf8'),
    tree: await readFile(join(runRoot, 'tree.json'), 'utf8'),
  }
}

function command(base, ...args) {
  return execFileAsync(process.execPath, [cli, '--base', base, ...args])
}

describe('subagent archive retention', () => {
  it('plans oldest derived artifacts without treating preserved metadata as reclaimable', () => {
    const plan = planArchiveRetention({
      archiveBytes: 900,
      maxBytes: 400,
      runs: [
        { conversationId: 'later', runId: 'r2', sortAt: 2, reclaimableBytes: 300 },
        { conversationId: 'early', runId: 'r1', sortAt: 1, reclaimableBytes: 300 },
      ],
    })
    expect(plan).toMatchObject({ reclaimableBytes: 600, projectedArchiveBytes: 300, thresholdReached: true })
    expect(plan.selectedRuns.map((run) => run.conversationId)).toEqual(['early', 'later'])
    expect(() => createArchiveRetentionManifest({
      kind: 'subagent_retention_prune', createdAt: 'now', archiveBytesBefore: 1, projectedArchiveBytesAfter: 0,
      selectedRuns: [{ conversationId: '..', runId: 'r', files: [{ path: 'events.jsonl', bytes: 1, sha256: 'a'.repeat(64) }] }],
    })).toThrow('unsafe identity')
  })

  it('is read-only by default and rejects a destructive prune without --write', async () => {
    const { base, runRoot, events, tree } = await fixture()
    const preview = await command(base, '--max-bytes', '200')
    expect(preview.stdout).toContain('archive_bytes=')
    expect(preview.stdout).toContain('select conversation/run:')
    await expect(command(base, '--prune', '--max-bytes', '200', '--export', '../outside')).rejects.toMatchObject({
      stderr: expect.stringContaining('--prune requires --max-bytes, --export, and --write'),
    })
    expect(await readFile(join(runRoot, 'events.jsonl'), 'utf8')).toBe(events)
    expect(await readFile(join(runRoot, 'tree.json'), 'utf8')).toBe(tree)
  })

  it('exports before pruning derived files, preserves events, and restores without overwriting them', async () => {
    const { base, exportPath, runRoot, events, tree } = await fixture()
    const pruned = await command(base, '--prune', '--max-bytes', '200', '--export', exportPath, '--write')
    expect(pruned.stdout).toContain('events_preserved=true')
    expect(await readFile(join(runRoot, 'events.jsonl'), 'utf8')).toBe(events)
    await expect(access(join(runRoot, 'tree.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const manifest = JSON.parse(await readFile(join(exportPath, 'manifest.json'), 'utf8'))
    expect(manifest.kind).toBe('subagent_retention_prune')
    expect(manifest.selectedRuns[0].files.map((file) => file.path)).not.toContain('events.jsonl')
    const beforeRestoreEvents = await readFile(join(runRoot, 'events.jsonl'), 'utf8')

    const restored = await command(base, '--restore', exportPath, '--write')
    expect(restored.stdout).toContain('events_preserved=true')
    expect(await readFile(join(runRoot, 'tree.json'), 'utf8')).toBe(tree)
    expect(await readFile(join(runRoot, 'events.jsonl'), 'utf8')).toBe(beforeRestoreEvents)
    const audit = (await readFile(join(base, '.agent-archive', 'governance', 'retention-actions.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse)
    expect(audit.map((record) => `${record.action}:${record.state}`)).toEqual([
      'prune:exported', 'prune:completed', 'restore:started', 'restore:completed',
    ])
  })

  it('exports a full completed run without changing the archive event stream', async () => {
    const { base, exportPath, runRoot, events, tree } = await fixture()
    const result = await command(base, '--export', exportPath, '--conversation', 'conversation', '--run', 'run', '--write')
    expect(result.stdout).toContain('exported=conversation/run')
    const manifest = JSON.parse(await readFile(join(exportPath, 'manifest.json'), 'utf8'))
    expect(manifest.kind).toBe('subagent_archive_export')
    expect(manifest.selectedRuns[0].files.map((file) => file.path)).toContain('events.jsonl')
    expect(await readFile(join(runRoot, 'events.jsonl'), 'utf8')).toBe(events)
    expect(await readFile(join(runRoot, 'tree.json'), 'utf8')).toBe(tree)
  })
})
