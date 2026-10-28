import type { ToolResult } from '@einfach-agent/core/tools'
import { ApiToolsError } from './api-error'

/** Converts host failures to the fixed public messages safe for model-visible output. */
export function asToolError(error: unknown): ToolResult {
  const classified = error instanceof ApiToolsError ? error : undefined
  const code = classified && safeErrorMessage(classified.code)
    ? classified.code
    : 'API_OPTIONS_NETWORK_ERROR'
  return {
    ok: false,
    error: safeErrorMessage(code),
    code,
    retryable: classified?.retryable ?? true,
  }
}

function safeErrorMessage(code: ApiToolsError['code']): string {
  const messages: Record<ApiToolsError['code'], string> = {
    API_OPTIONS_INVALID_INPUT: 'invalid query_options input',
    API_OPTIONS_UNKNOWN_SOURCE: 'options source is not registered',
    API_OPTIONS_FORBIDDEN: 'options source is not allowed for this session',
    API_OPTIONS_INVALID_RESPONSE: 'options source returned an invalid response',
    API_OPTIONS_CANCELLED: 'options query was cancelled',
    API_OPTIONS_TIMEOUT: 'options query timed out',
    API_OPTIONS_UNAUTHORIZED: 'options source authorization failed',
    API_OPTIONS_RATE_LIMITED: 'options source is rate limited',
    API_OPTIONS_SERVICE_ERROR: 'options source request failed',
    API_OPTIONS_NETWORK_ERROR: 'options source request failed',
  }
  return messages[code]
}
