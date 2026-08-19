// tools/write-file/write-file.ts -- workspace file writing tool. Side effects only go through ctx.
import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import guide from './write-file.md?raw'

const MAX_BYTES = 8 * 1024 * 1024

type WorkspaceWriteMode = 'create' | 'overwrite' | 'append' | 'upsert'
type WorkspaceWriteEncoding = 'utf8' | 'base64'

interface WorkspaceWriteInput {
  path: string
  content: string
  mode: WorkspaceWriteMode
  encoding?: WorkspaceWriteEncoding
  executable?: boolean
  dryRun?: boolean
  expectedOldContent?: string
  expectedContentHash?: string
  createDirs: boolean
}

interface WorkspaceWriteResult {
  ok: boolean
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  appended: boolean
  error?: string
}

type WorkspaceWriteContext = ToolContext & {
  writeWorkspaceFile(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult>
}

const inputSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Workspace-relative path to the text file.',
    },
    content: {
      type: 'string',
      description: 'Complete text to create/overwrite, or text to append in append mode.',
    },
    mode: {
      type: 'string',
      enum: ['create', 'overwrite', 'append', 'upsert'],
      default: 'create',
      description:
        'create refuses existing files; overwrite requires the file to exist; upsert writes either way (use it when you have not checked); append adds text.',
    },
    encoding: {
      type: 'string',
      enum: ['utf8', 'base64'],
      default: 'utf8',
      description:
        'How content is encoded. Use base64 to write binary files such as images; JSON strings cannot carry arbitrary bytes. Binary writes cannot be reverted.',
    },
    executable: {
      type: 'boolean',
      description:
        'Set or clear the executable bit after writing. Omit to keep the existing mode. No effect on Windows.',
    },
    dryRun: {
      type: 'boolean',
      default: false,
      description:
        'Validate the write, including optimistic guards, and report what would change without touching disk.',
    },
    expectedOldContent: {
      type: 'string',
      description:
        'Optimistic guard for overwrite/upsert/append on an existing file. Must be the complete, untruncated current file exactly as read, including every final newline. This is not a search snippet. Prefer expectedContentHash when read_file returned one.',
    },
    expectedContentHash: {
      type: 'string',
      pattern: '^sha256:[0-9a-f]{64}$',
      description:
        'Optimistic guard for overwrite/upsert/append on an existing file. Pass contentHash from a non-truncated read_file result to avoid copying or normalizing the old content.',
    },
    createDirs: {
      type: 'boolean',
      default: true,
      description: 'Create missing parent directories. Defaults to true; set false to require an existing parent.',
    },
  },
  required: ['path', 'content'],
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isMode(value: unknown): value is WorkspaceWriteMode {
  return value === 'create' || value === 'overwrite' || value === 'append' || value === 'upsert'
}

/** `create` requires the file to be absent, so a guard on previous content is meaningless. */
function allowsOptimisticGuard(mode: WorkspaceWriteMode): boolean {
  return mode !== 'create'
}

function isEncoding(value: unknown): value is WorkspaceWriteEncoding {
  return value === 'utf8' || value === 'base64'
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'writeWorkspaceFile failed'
}

function hasWorkspaceWrite(ctx: ToolContext): ctx is WorkspaceWriteContext {
  return typeof (ctx as { writeWorkspaceFile?: unknown }).writeWorkspaceFile === 'function'
}

export const writeFileTool: Tool = {
  name: 'write_file',
  runtime: 'server', // 依赖 Tauri 文件系统（ctx.writeWorkspaceFile），web 下不进 manifest（TP3）。
  replayUnsafe: true,
  skill: {
    description: '在当前 workspace 内写入文件（文本或 base64 二进制）。',
    triggers: ['write', 'file', 'workspace', '写文件', '生成文件', '二进制'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    const rawContent = input.content
    const hasStringContent = typeof rawContent === 'string'
    const content = hasStringContent ? rawContent : ''
    const mode = input.mode === undefined ? 'create' : input.mode
    const createDirs = input.createDirs === undefined ? true : input.createDirs
    const expectedOldContent = input.expectedOldContent
    const expectedContentHash = input.expectedContentHash
    const encoding = input.encoding === undefined ? 'utf8' : input.encoding
    const executable = input.executable
    const dryRun = input.dryRun

    if (!path || !hasStringContent) {
      return { ok: false, error: 'invalid write_file: path (non-empty) and string content are required' }
    }
    if (!isMode(mode)) {
      return {
        ok: false,
        error: 'invalid write_file: mode must be create, overwrite, upsert, or append',
      }
    }
    if (typeof createDirs !== 'boolean') {
      return { ok: false, error: 'invalid write_file: createDirs must be a boolean when provided' }
    }
    if (expectedOldContent !== undefined && typeof expectedOldContent !== 'string') {
      return { ok: false, error: 'invalid write_file: expectedOldContent must be a string when provided' }
    }
    if (
      expectedContentHash !== undefined &&
      (
        typeof expectedContentHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(expectedContentHash)
      )
    ) {
      return {
        ok: false,
        error: 'invalid write_file: expectedContentHash must use sha256:<64 lowercase hex characters>',
      }
    }
    if (
      !allowsOptimisticGuard(mode) &&
      (expectedOldContent !== undefined || expectedContentHash !== undefined)
    ) {
      return {
        ok: false,
        error:
          'invalid write_file: optimistic guards are not valid with mode "create"; the file must not exist',
      }
    }
    if (expectedOldContent !== undefined && expectedContentHash !== undefined) {
      return {
        ok: false,
        error: 'invalid write_file: pass either expectedOldContent or expectedContentHash, not both',
      }
    }
    if (!isEncoding(encoding)) {
      return { ok: false, error: 'invalid write_file: encoding must be utf8 or base64' }
    }
    if (executable !== undefined && typeof executable !== 'boolean') {
      return { ok: false, error: 'invalid write_file: executable must be a boolean when provided' }
    }
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      return { ok: false, error: 'invalid write_file: dryRun must be a boolean when provided' }
    }
    // A NUL byte in a utf8 payload is a sign the caller meant to send binary; point at
    // the encoding that actually supports it instead of just refusing.
    if (encoding === 'utf8' && content.includes('\0')) {
      return {
        ok: false,
        error: 'invalid write_file: binary content requires encoding "base64"',
      }
    }
    const contentBytes = byteLength(content)
    if (contentBytes > MAX_BYTES) {
      return {
        ok: false,
        error: `invalid write_file: content is too large (${contentBytes} bytes > ${MAX_BYTES})`,
      }
    }
    if (!hasWorkspaceWrite(ctx)) {
      return { ok: false, error: 'write_file is unavailable: ctx.writeWorkspaceFile is not configured' }
    }

    const writeInput: WorkspaceWriteInput = {
      path,
      content,
      mode,
      createDirs,
    }
    if (encoding !== 'utf8') {
      writeInput.encoding = encoding
    }
    if (executable !== undefined) {
      writeInput.executable = executable
    }
    if (dryRun !== undefined) {
      writeInput.dryRun = dryRun
    }
    if (expectedOldContent !== undefined) {
      writeInput.expectedOldContent = expectedOldContent
    }
    if (expectedContentHash !== undefined) {
      writeInput.expectedContentHash = expectedContentHash
    }

    try {
      const writeWorkspaceFile = ctx.writeWorkspaceFile as (
        input: WorkspaceWriteInput
      ) => Promise<WorkspaceWriteResult>
      const result = await writeWorkspaceFile(writeInput)
      if (!result.ok) {
        return {
          ok: false,
          error: result.error || `write_file was rejected for ${result.path || path}`,
        }
      }
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
