// ToolResult 到模型 tool message JSON 的唯一序列化协议。

import type { ToolOutputContentBlock } from '@einfach-agent/ai'
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

export interface ToolResultMessagePayload {
  readonly content: string
  readonly modelContent?: readonly ToolOutputContentBlock[]
}

/** Keeps image bytes out of generic result data while preserving schema warnings for the model. */
export function toolResultMessageForModel(
  result: ToolResult,
  pauseError: string,
): ToolResultMessagePayload {
  const content = serializeToolResultForModel(result, pauseError)
  if (!('pause' in result) && result.ok && result.modelContent) {
    return {
      content,
      modelContent: [{ type: 'text', text: content }, ...result.modelContent],
    }
  }
  return { content }
}
