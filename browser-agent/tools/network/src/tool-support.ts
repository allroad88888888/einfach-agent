import type { ToolContext, ToolResult } from '@einfach-agent/core/tools'
import { NetworkToolsError } from './network-error'

export function context(ctx: ToolContext) { return { sessionId: ctx.sessionId, signal: ctx.signal } }
export function toolError(error: unknown): ToolResult {
  const code = error instanceof NetworkToolsError ? error.code : 'CAPTURE_NOT_FOUND'
  const messages = {
    INVALID_INPUT: 'invalid network tool input', RECORDER_UNAVAILABLE: 'the page network recorder was not installed before this read', CAPTURE_NOT_FOUND: 'network capture was not found', REQUEST_NOT_FOUND: 'network request was not found',
    CAPTURE_STOPPED: 'network capture has stopped', DOCUMENT_CHANGED: 'target document has changed', TIMEOUT: 'network request wait timed out', CANCELLED: 'network request wait was cancelled',
  } as const
  return { ok: false, error: messages[code], code: `NETWORK_${code}`, retryable: code === 'TIMEOUT' }
}
