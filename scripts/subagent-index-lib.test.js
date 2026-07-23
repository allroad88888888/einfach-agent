import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compactSubagentIndex, subagentIndexKey } from './subagent-index-lib.js'

const execFileAsync = promisify(execFile)

describe('subagent index compaction', () => {
  it('keeps the latest run and agent records in latest-record order', () => {
    const runs = [
      { conversationId: 'c1', runId: 'r1', status: 'running' },
      { conversationId: 'c2', runId: 'r2', status: 'done' },
      { conversationId: 'c1', runId: 'r1', status: 'done' },
    ]
    const result = compactSubagentIndex('runs', `${runs.map(JSON.stringify).join('\n')}\n`)
    expect(result).toMatchObject({ records: 3, uniqueRecords: 2, removedRecords: 1 })
    expect(result.text.trim().split('\n').map(JSON.parse)).toEqual([runs[1], runs[2]])

    expect(subagentIndexKey('agents', { conversationId: 'c', runId: 'r', path: 'root-01' }))
      .toBe('c\u0000r\u0000root-01')
  })

  it('deduplicates skills by stable skillId and is idempotent', () => {
    const input = [
      JSON.stringify({ skillId: 'sk_1', summary: 'old' }),
      JSON.stringify({ skillId: 'sk_1', summary: 'new' }),
      JSON.stringify({ skillId: 'sk_2', summary: 'other' }),
      '',
    ].join('\n')
    const first = compactSubagentIndex('skills', input)
    const second = compactSubagentIndex('skills', first.text)
    expect(first.removedRecords).toBe(1)
    expect(second).toMatchObject({ records: 2, uniqueRecords: 2, removedRecords: 0 })
    expect(second.text).toBe(first.text)
  })

  it('fails closed on malformed JSON or missing logical keys', () => {
    expect(() => compactSubagentIndex('runs', '{bad}\n')).toThrow('runs index line 1: invalid JSON')
    expect(() => compactSubagentIndex('agents', '{"conversationId":"c","runId":"r"}\n'))
      .toThrow('agents index line 1: agents index record requires path')
    expect(() => compactSubagentIndex('skills', '[]\n')).toThrow('skills index record must be an object')
  })

  it('CLI is dry-run by default and only replaces indexes with --write', async () => {
    const basePath = await mkdtemp(join(tmpdir(), 'subagent-index-'))
    const indexRoot = join(basePath, '.agent-archive', 'index')
    await mkdir(indexRoot, { recursive: true })
    const runsPath = join(indexRoot, 'runs.jsonl')
    const original = [
      JSON.stringify({ conversationId: 'c', runId: 'r', status: 'running' }),
      JSON.stringify({ conversationId: 'c', runId: 'r', status: 'done' }),
      '',
    ].join('\n')
    await writeFile(runsPath, original, 'utf8')

    const script = join(process.cwd(), 'scripts', 'subagent-index-compact.js')
    const preview = await execFileAsync(process.execPath, [script, '--base', basePath])
    expect(preview.stdout).toContain('runs: dry-run; records=2, unique=1, removable=1')
    expect(await readFile(runsPath, 'utf8')).toBe(original)

    const write = await execFileAsync(process.execPath, [script, '--base', basePath, '--write'])
    expect(write.stdout).toContain('runs: compacted; records=2, unique=1, removable=1')
    await expect(stat(`${runsPath}.archive-write.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(runsPath, 'utf8')).trim()).toContain('"status":"done"')
  })
})
