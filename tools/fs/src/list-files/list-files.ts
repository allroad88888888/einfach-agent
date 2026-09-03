import type {
  Tool,
  ToolContext,
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
} from '@einfach-agent/core/tools'
import guide from './list-files.md?raw'
import {
  type CompatibleWorkspaceResult,
  workspaceResultToToolResult,
} from '../workspaceResultEnvelope'

const DEFAULT_MAX_ENTRIES = 200
const MAX_ENTRIES = 2_000

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', default: '.' },
    recursive: { type: 'boolean', default: false },
    maxEntries: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: DEFAULT_MAX_ENTRIES },
    includeHidden: { type: 'boolean', default: false },
  },
  additionalProperties: false,
}

type WorkspaceListContext = ToolContext & {
  listWorkspaceFiles(input: ListWorkspaceFilesInput): Promise<CompatibleWorkspaceResult<ListWorkspaceFilesResult>>
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

function normalizeBoolean(value: unknown, fallback: boolean, name: string): boolean | string {
  if (value === undefined) return fallback
  return typeof value === 'boolean'
    ? value
    : `invalid list_files: ${name} must be a boolean`
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'listWorkspaceFiles failed'
}

export const listFilesTool: Tool = {
  name: 'list_files',
  execution: { mode: 'parallel', effectKeys: ['workspace:read'] },
  runtime: 'server', // 依赖宿主本机文件系统（ctx.listWorkspaceFiles），没有本机能力桥（hasHostBridge()）时不进 manifest（TP3）。
  skill: {
    description: '列出目录文件项；Auto 模式也可列出 workspace 外的绝对路径或上级路径。',
    triggers: ['list files', '列目录', '目录', '文件列表'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'
    const recursive = normalizeBoolean(input.recursive, false, 'recursive')
    if (typeof recursive === 'string') {
      return { ok: false, error: recursive, code: 'WORKSPACE_LIST_INVALID_INPUT', retryable: false }
    }
    const includeHidden = normalizeBoolean(input.includeHidden, false, 'includeHidden')
    if (typeof includeHidden === 'string') {
      return { ok: false, error: includeHidden, code: 'WORKSPACE_LIST_INVALID_INPUT', retryable: false }
    }
    const maxEntries = normalizePositiveInteger(input.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES)
    const listWorkspaceFiles = (ctx as Partial<WorkspaceListContext>).listWorkspaceFiles
    if (typeof listWorkspaceFiles !== 'function') {
      return {
        ok: false,
        error: 'list_files is unavailable: ctx.listWorkspaceFiles is not configured',
        code: 'WORKSPACE_LIST_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      const result = await listWorkspaceFiles.call(ctx, {
        path,
        recursive,
        maxEntries,
        includeHidden,
      })
      return workspaceResultToToolResult(result, 'WORKSPACE_LIST_FAILED')
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'WORKSPACE_LIST_FAILED',
        retryable: false,
      }
    }
  },
}
