import { mkdtemp, open, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { acquireRolloutLock } from './rolloutLock'

describe('acquireRolloutLock', () => {
  it('waits for an active owner and then acquires', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const first = await acquireRolloutLock(history, { waitMs: 500 })
    const secondPromise = acquireRolloutLock(history, { waitMs: 500 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await first.release()
    const second = await secondPromise
    await second.release()
  })

  it('recovers a stale malformed lock', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    await writeFile(`${history}.lock`, 'broken')
    const old = new Date(Date.now() - 2_000)
    await utimes(`${history}.lock`, old, old)
    const lock = await acquireRolloutLock(history, { staleMs: 100, waitMs: 500 })
    await lock.release()
  })

  it('does not delete a replacement lock when released by a non-owner', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const lock = await acquireRolloutLock(history)
    await writeFile(lock.path, JSON.stringify({ pid: process.pid, token: 'replacement' }))
    await lock.release()
    expect(await readFile(lock.path, 'utf8')).toContain('replacement')
  })

  it('bounds lock waiting', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const lock = await acquireRolloutLock(history)
    await expect(acquireRolloutLock(history, { waitMs: 25, pollMs: 5 })).rejects.toThrow(/timed out/)
    await lock.release()
  })

  it('never steals a live parseable owner solely because its mtime is stale', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const lock = await acquireRolloutLock(history, { heartbeatMs: 10_000 })
    const old = new Date(Date.now() - 2_000)
    await utimes(lock.path, old, old)
    await expect(acquireRolloutLock(history, { staleMs: 10, waitMs: 30, pollMs: 5 })).rejects.toThrow(/timed out/)
    expect(await readFile(lock.path, 'utf8')).toContain(lock.token)
    await lock.release()
  })

  it('detects ownership loss before a writer enters its critical write', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const lock = await acquireRolloutLock(history)
    await writeFile(lock.path, JSON.stringify({ pid: process.pid, token: 'later-owner' }))
    await expect(lock.assertOwned()).rejects.toThrow(/ownership lost/)
    await lock.release()
    expect(await readFile(lock.path, 'utf8')).toContain('later-owner')
  })

  it('does not recover a new empty generation observed after an old empty stale lock', async () => {
    const history = join(await mkdtemp(join(tmpdir(), 'rollout-lock-')), 'root.jsonl')
    const path = `${history}.lock`
    await writeFile(path, '')
    const old = new Date(Date.now() - 2_000)
    await utimes(path, old, old)
    let replacement: Awaited<ReturnType<typeof open>> | undefined
    await expect(acquireRolloutLock(history, {
      staleMs: 1_000,
      waitMs: 30,
      pollMs: 5,
      async recoveryCandidateObserved() {
        if (replacement) return
        await unlink(path)
        replacement = await open(path, 'wx')
      },
    })).rejects.toThrow(/timed out/)
    expect(replacement).toBeDefined()
    const [observed, current] = await Promise.all([replacement!.stat(), stat(path)])
    expect([current.dev, current.ino]).toEqual([observed.dev, observed.ino])
    await replacement!.close()
    await unlink(path)
  })
})
