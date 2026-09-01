import { randomUUID } from 'node:crypto'
import { link, open, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

export const DEFAULT_ROLLOUT_LOCK_WAIT_MS = 10_000
export const DEFAULT_ROLLOUT_LOCK_STALE_MS = 30_000

export interface RolloutLockOptions {
  readonly heartbeatMs?: number
  readonly pollMs?: number
  readonly staleMs?: number
  readonly waitMs?: number
  /** Test seam invoked after a recoverable generation has been observed. */
  readonly recoveryCandidateObserved?: () => Promise<void>
}

export interface RolloutLock {
  readonly path: string
  readonly token: string
  assertOwned(): Promise<void>
  release(): Promise<void>
}

interface LockOwner { readonly pid: number; readonly token: string }

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function lockPath(historyPath: string): string {
  return `${historyPath}.lock`
}

function parseOwner(value: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<LockOwner>
    if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.token === 'string') {
      return { pid: Number(owner.pid), token: owner.token }
    }
  } catch { /* a malformed owner is recoverable only after it becomes stale */ }
  return undefined
}

function ownerIsDead(owner: LockOwner | undefined): boolean {
  if (!owner) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

interface RecoveryCandidate { readonly contents: string; readonly handle: FileHandle; readonly identity: Stats }

async function recoveryCandidate(path: string, staleMs: number): Promise<RecoveryCandidate | undefined> {
  let handle: FileHandle
  try { handle = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const contents = await handle.readFile('utf8')
    const identity = await handle.stat()
    const owner = parseOwner(contents)
    if (owner ? ownerIsDead(owner) : Date.now() - identity.mtimeMs >= staleMs) return { contents, handle, identity }
    await handle.close()
    return undefined
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  if (left.ino !== 0 && right.ino !== 0) return left.dev === right.dev && left.ino === right.ino
  return left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
    && left.mode === right.mode
}

async function restoreWithoutOverwrite(claimPath: string, path: string): Promise<void> {
  await link(claimPath, path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await unlink(claimPath).catch(() => undefined)
}

async function claimObservedFile(
  path: string,
  claimPath: string,
  observed: FileHandle,
  identity: Stats,
  expectedContents?: string,
): Promise<boolean> {
  try { await rename(path, claimPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const [observedNow, claimed] = await Promise.all([observed.stat(), stat(claimPath)])
  const contentsMatch = expectedContents === undefined || await readFile(claimPath, 'utf8') === expectedContents
  if (sameFile(identity, observedNow) && sameFile(identity, claimed) && contentsMatch) return true
  await restoreWithoutOverwrite(claimPath, path)
  return false
}

async function createOwnedLock(path: string, token: string, heartbeatMs: number): Promise<RolloutLock> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(path).catch(() => undefined)
    throw error
  }
  return managedLock(path, token, handle, heartbeatMs)
}

function managedLock(path: string, token: string, handle: FileHandle, heartbeatMs: number): RolloutLock {
  const heartbeat = setInterval(() => void handle.utimes(new Date(), new Date()).catch(() => clearInterval(heartbeat)), heartbeatMs)
  heartbeat.unref()
  let released = false
  async function assertOwned(): Promise<void> {
    const owner = parseOwner(await readFile(path, 'utf8').catch(() => ''))
    if (owner?.token !== token) throw new Error(`rollout lock ownership lost: ${path}`)
  }
  return { path, token, assertOwned, async release() {
    if (released) return
    released = true
    clearInterval(heartbeat)
    const claimPath = `${path}.release-${token}`
    let claimed = false
    try {
      claimed = await claimObservedFile(
        path,
        claimPath,
        handle,
        await handle.stat(),
        JSON.stringify({ pid: process.pid, token }),
      )
    } finally {
      await handle.close()
    }
    if (claimed) {
      await unlink(claimPath).catch(() => undefined)
    }
  } }
}

/** Acquires the lock dedicated to one history file, recovering only dead or stale owners. */
export async function acquireRolloutLock(historyPath: string, options: RolloutLockOptions = {}): Promise<RolloutLock> {
  const path = lockPath(historyPath)
  const staleMs = options.staleMs ?? DEFAULT_ROLLOUT_LOCK_STALE_MS
  const waitMs = options.waitMs ?? DEFAULT_ROLLOUT_LOCK_WAIT_MS
  const pollMs = options.pollMs ?? 20
  const heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3))
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  for (;;) {
    try { return await createOwnedLock(path, token, heartbeatMs) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const candidate = await recoveryCandidate(path, staleMs)
    if (candidate) {
      const displaced = `${path}.stale-${token}`
      try {
        await options.recoveryCandidateObserved?.()
        if (await claimObservedFile(path, displaced, candidate.handle, candidate.identity, candidate.contents)) {
          await unlink(displaced).catch(() => undefined)
          continue
        }
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      } finally {
        await candidate.handle.close().catch(() => undefined)
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for rollout lock: ${path}`)
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}
