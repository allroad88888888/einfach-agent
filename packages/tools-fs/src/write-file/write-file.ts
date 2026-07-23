// tools/write-file/write-file.ts -- workspace file writing tool. Side effects only go through ctx.
import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import guide from './write-file.md?raw'

const DEFAULT_MAX_BYTES = 200 * 1024
const MAX_BYTES = 1024 * 1024

type WorkspaceWriteMode = 'create' | 'overwrite' | 'append'

interface WorkspaceWriteInput {
  path: string
  content: string
  mode: WorkspaceWriteMode
  expectedOldContent?: string
  createDirs: boolean
  maxBytes: number
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
    path: { type: 'string' },
    content: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['create', 'overwrite', 'append'],
      default: 'create',
    },
    expectedOldContent: { type: 'string' },
    createDirs: { type: 'boolean', default: false },
    maxBytes: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_BYTES,
      default: DEFAULT_MAX_BYTES,
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
  return value === 'create' || value === 'overwrite' || value === 'append'
}

function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_BYTES
  }
  return Math.min(Math.floor(value), MAX_BYTES)
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
  skill: {
    description: '在当前 workspace 内写入小型文本文件。',
    triggers: ['write', 'file', 'workspace', '写文件', '生成文件'],
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
    const createDirs = input.createDirs === undefined ? false : input.createDirs
    const expectedOldContent = input.expectedOldContent
    const maxBytes = normalizeMaxBytes(input.maxBytes)

    if (!path || !hasStringContent) {
      return { ok: false, error: 'invalid write_file: path (non-empty) and string content are required' }
    }
    if (!isMode(mode)) {
      return { ok: false, error: 'invalid write_file: mode must be create, overwrite, or append' }
    }
    if (typeof createDirs !== 'boolean') {
      return { ok: false, error: 'invalid write_file: createDirs must be a boolean when provided' }
    }
    if (expectedOldContent !== undefined && typeof expectedOldContent !== 'string') {
      return { ok: false, error: 'invalid write_file: expectedOldContent must be a string when provided' }
    }
    if (content.includes('\0')) {
      return { ok: false, error: 'invalid write_file: binary content is not supported' }
    }
    const contentBytes = byteLength(content)
    if (contentBytes > maxBytes) {
      return {
        ok: false,
        error: `invalid write_file: content is too large (${contentBytes} bytes > ${maxBytes})`,
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
      maxBytes,
    }
    if (expectedOldContent !== undefined) {
      writeInput.expectedOldContent = expectedOldContent
    }

    try {
      const result = await ctx.writeWorkspaceFile(writeInput)
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
