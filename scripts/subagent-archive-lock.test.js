import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireArchivePathLock, archiveLockPath } from './subagent-archive-lock.js'

const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function target() {
  const root = await mkdtemp(join(tmpdir(), 'subagent-archive-lock-'))
  roots.push(root)
  const path = join(root, 'runs.jsonl')
  await writeFile(path, '', 'utf8')
  return path
}

describe('subagent archive path lock', () => {
  it('serializes independent owners and only releases its own token', async () => {
    const path = await target()
    const first = await acquireArchivePathLock(path)
    let secondAcquired = false
    const secondPromise = acquireArchivePathLock(path, { waitMs: 500 }).then((lock) => {
      secondAcquired = true
      return lock
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondAcquired).toBe(false)
    await first.release()
    const second = await secondPromise
    expect(secondAcquired).toBe(true)
    await second.release()
    await expect(stat(archiveLockPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an expired lock and preserves a replacement lock on late release', async () => {
    const path = await target()
    const first = await acquireArchivePathLock(path)
    const firstToken = await readFile(archiveLockPath(path), 'utf8')
    const replacement = await acquireArchivePathLock(path, { staleMs: 0, waitMs: 100 })
    const replacementToken = await readFile(archiveLockPath(path), 'utf8')

    expect(replacementToken).not.toBe(firstToken)
    await first.release()
    expect(await readFile(archiveLockPath(path), 'utf8')).toBe(replacementToken)
    await replacement.release()
  })

  it('propagates lock timeouts without removing the owner lock', async () => {
    const path = await target()
    const first = await acquireArchivePathLock(path)
    await expect(
      acquireArchivePathLock(path, { staleMs: 60_000, waitMs: 20, pollMs: 5 }),
    ).rejects.toThrow('timed out waiting')
    expect(await readFile(archiveLockPath(path), 'utf8')).toBeTruthy()
    await first.release()
  })
})
