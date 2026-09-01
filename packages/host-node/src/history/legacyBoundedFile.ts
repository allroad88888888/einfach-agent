import { open } from 'node:fs/promises'

export type LegacyBoundedFileResult =
  | { readonly status: 'missing' }
  | { readonly status: 'oversized'; readonly bytesRead: number; readonly snapshot: string }
  | { readonly status: 'ok'; readonly bytesRead: number; readonly text: string; readonly snapshot: string }

/** Reads at most cap+1 bytes from one opened regular-file handle. */
export async function readLegacyBoundedFile(
  path: string,
  cap: number,
): Promise<LegacyBoundedFileResult> {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Legacy file cap must be non-negative')
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) return { status: 'missing' }
    const buffer = Buffer.allocUnsafe(cap + 1)
    const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0)
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Legacy file identity changed while reading')
    const snapshot = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`
    if (bytesRead > cap) return { status: 'oversized', bytesRead, snapshot }
    return {
      status: 'ok',
      bytesRead,
      text: buffer.toString('utf8', 0, bytesRead),
      snapshot,
    }
  } finally {
    await handle.close()
  }
}
