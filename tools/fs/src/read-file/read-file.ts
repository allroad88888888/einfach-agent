import type { Tool, ToolContext, ToolResult } from '@web-agent/core/tools/types'
import type {
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import guide from './read-file.md?raw'

const DEFAULT_MAX_BYTES = 20_000
const MAX_BYTES = 200_000

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    maxBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES, default: DEFAULT_MAX_BYTES },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'UTF-8 byte offset; use the previous result.nextOffset to continue safely',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

type MaybeWorkspaceResult<T> = WorkspaceRuntimeResult<T> | T

type WorkspaceReadContext = ToolContext & {
  readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<MaybeWorkspaceResult<ReadWorkspaceFileResult>>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(Math.floor(value), max)
}

function normalizeOffset(value: unknown): number | string {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return 'invalid read_file: offset must be a non-negative safe integer'
  }
  return value as number
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'readWorkspaceFile failed'
}

function toToolResult<T>(result: MaybeWorkspaceResult<T>): ToolResult {
  if (isStructuredResult(result)) {
    return result.ok
      ? { ok: true, data: result.data }
      : {
          ok: false,
          error: result.error,
          code: 'WORKSPACE_READ_FAILED',
          retryable: false,
        }
  }
  return { ok: true, data: result }
}

function isStructuredResult<T>(value: MaybeWorkspaceResult<T>): value is WorkspaceRuntimeResult<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

export const readFileTool: Tool = {
  name: 'read_file',
  execution: { mode: 'parallel', effectKeys: ['workspace:read'] },
  runtime: 'server', // 依赖 Tauri 文件系统（ctx.readWorkspaceFile），web 下不进 manifest（TP3）。
  skill: {
    description: '读取文本文件内容；Auto 模式也可读取 workspace 外的绝对路径或上级路径。',
    triggers: ['read file', '读取文件', '查看文件', '打开文件'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path) {
      return {
        ok: false,
        error: 'invalid read_file: path (non-empty string) is required',
        code: 'WORKSPACE_READ_INVALID_INPUT',
        retryable: false,
      }
    }

    const maxBytes = normalizePositiveInteger(input.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES)
    const offset = normalizeOffset(input.offset)
    if (typeof offset === 'string') {
      return {
        ok: false,
        error: offset,
        code: 'WORKSPACE_READ_INVALID_INPUT',
        retryable: false,
      }
    }
    const readWorkspaceFile = (ctx as Partial<WorkspaceReadContext>).readWorkspaceFile
    if (typeof readWorkspaceFile !== 'function') {
      return {
        ok: false,
        error: 'read_file is unavailable: ctx.readWorkspaceFile is not configured',
        code: 'WORKSPACE_READ_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      const result = await readWorkspaceFile.call(ctx, { path, maxBytes, offset })
      return toToolResult(result)
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'WORKSPACE_READ_FAILED',
        retryable: false,
      }
    }
  },
}
