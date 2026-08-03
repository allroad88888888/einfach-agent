import type { ToolResult } from '../tools/types'

export type CompletedToolResult = Exclude<ToolResult, { pause: unknown }>

export type ToolResultPatch =
  | { data?: unknown; warnings?: string[] }
  | { error?: string; code?: string; hint?: string; retryable?: boolean; details?: unknown }

export class InvalidToolResultPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidToolResultPatchError'
  }
}

const successKeys = new Set(['data', 'warnings'])
const failureKeys = new Set(['error', 'code', 'hint', 'retryable', 'details'])

/** Applies a plugin result patch without allowing it to change the result branch. */
export function applyToolResultPatch(
  result: CompletedToolResult,
  patch: ToolResultPatch | undefined,
): CompletedToolResult {
  if (patch === undefined) return result
  if (!isPlainObject(patch)) throw new InvalidToolResultPatchError('patch 必须是对象')
  if ('ok' in patch || 'pause' in patch) {
    throw new InvalidToolResultPatchError('patch 不能覆盖 ok 或 pause 控制字段')
  }
  const allowed = result.ok ? successKeys : failureKeys
  const merged: Record<string, unknown> = { ...result }
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new InvalidToolResultPatchError(`patch 不能修改 ${key}`)
    validatePatchValue(key, value)
    if (value !== undefined) merged[key] = value
  }
  return merged as CompletedToolResult
}

/** Derives the smallest patch that reproduces a validated result transition. */
export function toolResultPatchBetween(
  previous: CompletedToolResult,
  next: CompletedToolResult,
): ToolResultPatch | undefined {
  const keys = previous.ok ? successKeys : failureKeys
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.is(previous[key as keyof typeof previous], next[key as keyof typeof next])) {
      patch[key] = next[key as keyof typeof next]
    }
  }
  return Object.keys(patch).length > 0 ? patch as ToolResultPatch : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatePatchValue(key: string, value: unknown): void {
  if (value === undefined || key === 'data' || key === 'details') return
  if ((key === 'error' || key === 'code' || key === 'hint') && typeof value !== 'string') {
    throw new InvalidToolResultPatchError(`${key} 必须是字符串`)
  }
  if (key === 'retryable' && typeof value !== 'boolean') {
    throw new InvalidToolResultPatchError('retryable 必须是布尔值')
  }
  if (key === 'warnings' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
    throw new InvalidToolResultPatchError('warnings 必须是字符串数组')
  }
}
