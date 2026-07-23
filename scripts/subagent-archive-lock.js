import { randomUUID } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'

export const ARCHIVE_LOCK_STALE_MS = 30_000
export const ARCHIVE_LOCK_WAIT_MS = 10_000

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function archiveLockPath(targetPath) {
  return `${targetPath}.archive-write.lock`
}

async function lockOwnerIsDead(lockPath) {
  const token = await readFile(lockPath, 'utf8').catch(() => '')
  const pid = Number.parseInt(token.split('-', 1)[0], 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

export async function acquireArchivePathLock(targetPath, options = {}) {
  const lockPath = archiveLockPath(targetPath)
  const staleMs = options.staleMs ?? ARCHIVE_LOCK_STALE_MS
  const waitMs = options.waitMs ?? ARCHIVE_LOCK_WAIT_MS
  const pollMs = options.pollMs ?? 20
  const token = `${process.pid}-${randomUUID()}`
  const startedAt = Date.now()

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(token, 'utf8')
      } catch (error) {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        throw error
      }
      const heartbeat = setInterval(() => {
        void handle.write(token, 0, 'utf8').catch(() => clearInterval(heartbeat))
      }, 5_000)
      heartbeat.unref()
      return {
        path: lockPath,
        async release() {
          clearInterval(heartbeat)
          await handle.close().catch(() => undefined)
          const owner = await readFile(lockPath, 'utf8').catch(() => undefined)
          if (owner === token) await unlink(lockPath).catch(() => undefined)
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(`failed to acquire archive path lock: ${error?.message ?? error}`)
      }
    }

    const metadata = await stat(lockPath).catch(() => undefined)
    if (metadata && (Date.now() - metadata.mtimeMs >= staleMs || await lockOwnerIsDead(lockPath))) {
      const stalePath = `${lockPath}.stale-${token}`
      try {
        await rename(lockPath, stalePath)
        await unlink(stalePath).catch(() => undefined)
        continue
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes(error?.code)) {
          throw new Error(`failed to recover stale archive path lock: ${error?.message ?? error}`)
        }
      }
    }

    if (Date.now() - startedAt >= waitMs) {
      throw new Error(`timed out waiting for archive path lock \`${lockPath}\``)
    }
    await delay(pollMs)
  }
}

export async function acquireArchivePathLocks(targetPaths, options) {
  const locks = []
  try {
    for (const targetPath of [...new Set(targetPaths)].sort()) {
      locks.push(await acquireArchivePathLock(targetPath, options))
    }
    return async () => {
      for (const lock of locks.reverse()) await lock.release()
    }
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release()
    throw error
  }
}
