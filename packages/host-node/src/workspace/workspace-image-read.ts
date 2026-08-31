import type { FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostCommandHandler } from '../routeTable'
import { isWithinRoot, resolveExistingWorkspacePath, resolveWorkspaceRoot } from './common'
import { resolveWorkspaceImageHandlePath } from './workspace-image-handle-path'
import { openWorkspaceImageHandle } from './workspace-image-open'

export const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024

const READ_CHUNK_BYTES = 64 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type WorkspaceImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface WorkspaceImageReadResult {
  base64: string
  mimeType: WorkspaceImageMimeType
  filename: string
  sizeBytes: number
}

interface WorkspaceImageReadHooks {
  afterResolve?(): Promise<void> | void
  beforeRead?(handle: FileHandle): Promise<void> | void
  resolveHandlePath?(fd: number): Promise<string>
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function imageReadLimit(args: Record<string, unknown>): number {
  const value = args.max_bytes
  if (value === undefined) return MAX_WORKSPACE_IMAGE_BYTES
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('max_bytes must be a positive integer')
  }
  if (value > MAX_WORKSPACE_IMAGE_BYTES) {
    throw new Error(`max_bytes cannot exceed ${MAX_WORKSPACE_IMAGE_BYTES}`)
  }
  return value
}

function detectMimeType(bytes: Buffer): WorkspaceImageMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png'
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

async function verifyOpenedImage(
  handle: FileHandle,
  root: string,
  allowExternalPaths: boolean,
  resolveHandlePath: (fd: number) => Promise<string>,
): Promise<void> {
  try {
    const handlePath = await resolveHandlePath(handle.fd)
    if (!allowExternalPaths && !isWithinRoot(root, handlePath)) throw new Error('outside root')
  } catch {
    throw new Error('requested image changed during access')
  }
}

async function readBounded(
  handle: FileHandle,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= limit) {
    const size = Math.min(READ_CHUNK_BYTES, limit + 1 - total)
    const chunk = Buffer.allocUnsafe(size)
    let bytesRead: number
    try {
      ;({ bytesRead } = await handle.read(chunk, 0, size, null))
    } catch {
      throw new Error('failed to read requested image')
    }
    if (bytesRead === 0) break
    chunks.push(bytesRead === size ? chunk : chunk.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total > limit) throw new Error(`image exceeds the ${limit} byte limit`)
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
}

export async function readWorkspaceImage(
  args: Record<string, unknown>,
  hooks: WorkspaceImageReadHooks = {},
): Promise<WorkspaceImageReadResult> {
  const root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))
  const requested = (stringArg(args, 'path') ?? '').trim()
  if (!requested) throw new Error('path (non-empty string) is required')

  const limit = imageReadLimit(args)
  const allowExternalPaths = args.allow_external_paths === true
  const { absolutePath } = await resolveExistingWorkspacePath(root, requested, {
    allowExternalPaths,
  })
  await hooks.afterResolve?.()
  const { handle, stats } = await openWorkspaceImageHandle(absolutePath)
  let bytes: Buffer
  try {
    await verifyOpenedImage(
      handle,
      root,
      allowExternalPaths,
      hooks.resolveHandlePath ?? resolveWorkspaceImageHandlePath,
    )
    if (stats.size > BigInt(limit)) throw new Error(`image exceeds the ${limit} byte limit`)
    await hooks.beforeRead?.(handle)
    bytes = await readBounded(handle, limit)
  } finally {
    await handle.close().catch(() => {})
  }

  const mimeType = detectMimeType(bytes)
  if (!mimeType) throw new Error('requested file is not a supported JPEG, PNG, or WebP image')
  return {
    base64: bytes.toString('base64'),
    mimeType,
    filename: basename(requested),
    sizeBytes: bytes.byteLength,
  }
}

export function createReadWorkspaceImageHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => readWorkspaceImage(args)
}
