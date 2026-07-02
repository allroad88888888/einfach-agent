import type { Tool, ToolContext } from '../types'
import type {
  WorkspacePatchInput,
  WorkspacePatchOperation,
  WorkspacePatchResult,
} from '../../runtime/workspacePatch'
import guide from './apply-patch.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'add_file' },
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['type', 'path', 'content'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'delete_file' },
              path: { type: 'string' },
              oldContent: { type: 'string' },
            },
            required: ['type', 'path'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'replace' },
              path: { type: 'string' },
              oldText: { type: 'string' },
              newText: { type: 'string' },
              expectedReplacements: { type: 'integer', minimum: 1 },
            },
            required: ['type', 'path', 'oldText', 'newText'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'overwrite_file' },
              path: { type: 'string' },
              content: { type: 'string' },
              oldContent: { type: 'string' },
            },
            required: ['type', 'path', 'content'],
          },
        ],
      },
    },
    dryRun: { type: 'boolean' },
  },
  required: ['operations'],
}

type WorkspacePatchContext = ToolContext & {
  applyWorkspacePatch?: (input: WorkspacePatchInput) => Promise<WorkspacePatchResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'applyWorkspacePatch failed'
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  return path ? path : undefined
}

function normalizeExpectedReplacements(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

function normalizeOperation(value: unknown, index: number): WorkspacePatchOperation | string {
  const operation = asRecord(value)
  const type = operation.type
  const path = normalizePath(operation.path)
  if (typeof type !== 'string' || !path) {
    return `invalid apply_patch: operations[${index}] must include type and non-empty path`
  }

  switch (type) {
    case 'add_file': {
      if (typeof operation.content !== 'string') {
        return `invalid apply_patch: operations[${index}].content must be a string`
      }
      return { type, path, content: operation.content }
    }
    case 'delete_file': {
      if (operation.oldContent !== undefined && typeof operation.oldContent !== 'string') {
        return `invalid apply_patch: operations[${index}].oldContent must be a string`
      }
      return operation.oldContent === undefined
        ? { type, path }
        : { type, path, oldContent: operation.oldContent }
    }
    case 'replace': {
      if (typeof operation.oldText !== 'string' || operation.oldText.length === 0) {
        return `invalid apply_patch: operations[${index}].oldText must be a non-empty string`
      }
      if (typeof operation.newText !== 'string') {
        return `invalid apply_patch: operations[${index}].newText must be a string`
      }
      const expectedReplacements = normalizeExpectedReplacements(operation.expectedReplacements)
      if (operation.expectedReplacements !== undefined && expectedReplacements === undefined) {
        return `invalid apply_patch: operations[${index}].expectedReplacements must be a positive integer`
      }
      return expectedReplacements === undefined
        ? { type, path, oldText: operation.oldText, newText: operation.newText }
        : {
            type,
            path,
            oldText: operation.oldText,
            newText: operation.newText,
            expectedReplacements,
          }
    }
    case 'overwrite_file': {
      if (typeof operation.content !== 'string') {
        return `invalid apply_patch: operations[${index}].content must be a string`
      }
      if (operation.oldContent !== undefined && typeof operation.oldContent !== 'string') {
        return `invalid apply_patch: operations[${index}].oldContent must be a string`
      }
      return operation.oldContent === undefined
        ? { type, path, content: operation.content }
        : { type, path, content: operation.content, oldContent: operation.oldContent }
    }
    default:
      return `invalid apply_patch: unsupported operation type ${JSON.stringify(type)}`
  }
}

function normalizeInput(args: unknown): WorkspacePatchInput | string {
  const input = asRecord(args)
  if (!Array.isArray(input.operations)) {
    return 'invalid apply_patch: operations (array) is required'
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    return 'invalid apply_patch: dryRun must be a boolean when provided'
  }

  const operations: WorkspacePatchOperation[] = []
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = normalizeOperation(input.operations[index], index)
    if (typeof operation === 'string') return operation
    operations.push(operation)
  }

  return input.dryRun === undefined ? { operations } : { operations, dryRun: input.dryRun }
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  runtime: 'server', // 依赖 Tauri 文件系统（ctx.applyWorkspacePatch），web 下不进 manifest（TP3）。
  skill: {
    description: 'Apply a structured, workspace-confined file patch through the desktop runtime.',
    triggers: ['apply_patch', 'patch', 'edit file', '修改文件'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = normalizeInput(args)
    if (typeof input === 'string') {
      return { ok: false, error: input }
    }

    const patchCtx = ctx as WorkspacePatchContext
    if (typeof patchCtx.applyWorkspacePatch !== 'function') {
      return {
        ok: false,
        error: 'apply_patch unavailable: ctx.applyWorkspacePatch is not configured',
      }
    }

    try {
      const result = await patchCtx.applyWorkspacePatch(input)
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
