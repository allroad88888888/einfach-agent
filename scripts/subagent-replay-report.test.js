import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { resolveArchiveRunPath } from './subagent-archive-paths.js'

const execFileAsync = promisify(execFile)
const cli = resolve(process.cwd(), 'scripts/subagent-replay-report.js')

describe('subagent replay report', () => {
  it('reads run IDs through the shared safe archive mapping', async () => {
    const base = await mkdtemp(join(tmpdir(), 'subagent-replay-report-'))
    const archiveRoot = join(base, '.webAgent-archive')
    const runPath = resolveArchiveRunPath(archiveRoot, '..', '.')
    await mkdir(runPath, { recursive: true })
    await writeFile(join(runPath, 'events.jsonl'), '')

    const result = await execFileAsync(process.execPath, [cli, '--base', base, '--conversation', '..', '--run', '.', '--json'])

    expect(JSON.parse(result.stdout)).toMatchObject({ conversationId: '', runId: '' })
  })
})
