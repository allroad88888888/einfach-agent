import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

const UNSUPPORTED_PLATFORM_ERROR = 'workspace image reads are unavailable on this platform'
const OPEN_ERROR = 'failed to open requested image'
const CHANGED_ERROR = 'requested image changed during access'
const NOT_FILE_ERROR = 'requested image is not a file'

export interface WorkspaceImageOpenDependencies {
  platform: NodeJS.Platform
  open(path: string, flags: number): Promise<FileHandle>
}

export interface OpenedWorkspaceImage {
  handle: FileHandle
  stats: BigIntStats
}

const defaultDependencies: WorkspaceImageOpenDependencies = {
  platform: process.platform,
  open,
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => {})
}

export async function openWorkspaceImageHandle(
  path: string,
  dependencies: WorkspaceImageOpenDependencies = defaultDependencies,
): Promise<OpenedWorkspaceImage> {
  if (dependencies.platform !== 'linux' && dependencies.platform !== 'darwin') {
    throw new Error(UNSUPPORTED_PLATFORM_ERROR)
  }

  let handle: FileHandle
  try {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    handle = await dependencies.open(path, flags)
  } catch {
    throw new Error(OPEN_ERROR)
  }

  let stats: BigIntStats
  try {
    stats = await handle.stat({ bigint: true })
  } catch {
    await closeQuietly(handle)
    throw new Error(CHANGED_ERROR)
  }
  if (!stats.isFile()) {
    await closeQuietly(handle)
    throw new Error(NOT_FILE_ERROR)
  }
  return { handle, stats }
}
