import type {
  WorkspaceImageMimeType,
  WorkspaceImageReadInput,
  WorkspaceImageReadResult,
} from '../tools/types'
import { hasHostBridge, loadHostInvoke } from './hostBridge'
import type { WorkspaceRuntimeResult } from './workspaceRead'

export type {
  WorkspaceImageMimeType,
  WorkspaceImageReadInput,
  WorkspaceImageReadResult,
} from '../tools/types'

type HostWorkspaceImageInput = {
  path: string
  max_bytes?: number
  workspace_root?: string
  allow_external_paths?: boolean
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function fail(error: string): WorkspaceRuntimeResult<WorkspaceImageReadResult> {
  return { ok: false, error }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toHostInput(input: WorkspaceImageReadInput): HostWorkspaceImageInput {
  return {
    path: input.path,
    max_bytes: input.maxBytes,
    workspace_root: input.workspaceRoot,
    allow_external_paths: input.allowExternalPaths,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodedBase64Size(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function decodedPrefix(value: string): Uint8Array | undefined {
  try {
    const decoded = globalThis.atob(value.slice(0, 16))
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return undefined
  }
}

function prefixMimeType(bytes: Uint8Array): WorkspaceImageMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'image/png'
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

function effectiveSizeLimit(input: WorkspaceImageReadInput): number {
  const requested = input.maxBytes ?? MAX_WORKSPACE_IMAGE_BYTES
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0
  return Math.min(requested, MAX_WORKSPACE_IMAGE_BYTES)
}

function normalizeResult(
  raw: unknown,
  input: WorkspaceImageReadInput,
): WorkspaceRuntimeResult<WorkspaceImageReadResult> {
  if (!isRecord(raw)) return fail('read_workspace_image returned an invalid response')
  const { base64, mimeType, filename, sizeBytes } = raw
  if (
    typeof base64 !== 'string'
    || typeof mimeType !== 'string'
    || !IMAGE_MIME_TYPES.has(mimeType)
    || typeof filename !== 'string'
    || filename.length === 0
    || typeof sizeBytes !== 'number'
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || sizeBytes > effectiveSizeLimit(input)
    || decodedBase64Size(base64) !== sizeBytes
    || prefixMimeType(decodedPrefix(base64) ?? new Uint8Array()) !== mimeType
  ) {
    return fail('read_workspace_image returned an invalid response')
  }
  return {
    ok: true,
    data: {
      base64,
      mimeType: mimeType as WorkspaceImageMimeType,
      filename,
      sizeBytes,
    },
  }
}

export async function readWorkspaceImage(
  input: WorkspaceImageReadInput,
): Promise<WorkspaceRuntimeResult<WorkspaceImageReadResult>> {
  if (!hasHostBridge()) return fail('read_workspace_image：当前宿主未提供命令桥')
  try {
    const invoke = await loadHostInvoke()
    return normalizeResult(await invoke<unknown>('read_workspace_image', toHostInput(input)), input)
  } catch (error) {
    return fail(`read_workspace_image failed: ${errorMessage(error)}`)
  }
}
