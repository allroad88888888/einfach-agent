// ToolResult 到模型 tool message JSON 的唯一序列化协议。

import type { ToolResult } from './types'

/** pause 的错误文案由 root/child 信任边界显式提供，其余 ToolResult 字段共享同一投影。 */
export function serializeToolResultForModel(result: ToolResult, pauseError: string): string {
  if ('pause' in result) return JSON.stringify({ error: pauseError })
  if (result.ok) {
    const data = result.data ?? { ok: true }
    return JSON.stringify(result.warnings?.length ? { data, warnings: result.warnings } : data)
  }
  return JSON.stringify({
    error: result.error,
    ...(result.code ? { code: result.code } : {}),
    ...(result.hint ? { hint: result.hint } : {}),
    ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
    ...(result.details !== undefined ? { details: result.details } : {}),
  })
}
