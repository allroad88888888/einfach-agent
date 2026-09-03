// workspace bridge 新 envelope 与旧直接结果的兼容协议。

import type { ToolResult, WorkspaceRuntimeResult } from '@einfach-agent/core/tools'

export type CompatibleWorkspaceResult<T> = WorkspaceRuntimeResult<T> | T

/** 识别带布尔 ok 判别字段的 workspace runtime envelope。 */
export function isWorkspaceResultEnvelope<T = unknown>(
  value: unknown,
): value is WorkspaceRuntimeResult<T> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

/** 读取兼容结果；runtime failure 保持原 error 文案并抛出。 */
export function unwrapWorkspaceResult<T>(value: CompatibleWorkspaceResult<T>): T {
  if (!isWorkspaceResultEnvelope(value)) return value
  if (value.ok) return value.data
  throw new Error(value.error)
}

/** 把兼容结果映射为工具协议，并由工具域保留自己的失败 code。 */
export function workspaceResultToToolResult<T>(
  value: CompatibleWorkspaceResult<T>,
  failureCode: string,
): ToolResult {
  if (!isWorkspaceResultEnvelope(value)) return { ok: true, data: value }
  return value.ok
    ? { ok: true, data: value.data }
    : { ok: false, error: value.error, code: failureCode, retryable: false }
}
