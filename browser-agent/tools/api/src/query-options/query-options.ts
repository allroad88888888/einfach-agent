import type { Tool, ToolContext, ToolRegistry, ToolResult } from '@einfach-agent/core/tools'
import { ApiToolsError } from '../api-error'
import type { ApiToolsHost, QueryOptionsInput } from '../options-host'
import guide from './query-options.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    sourceId: { type: 'string', minLength: 1, maxLength: 500 },
    query: { type: 'string', minLength: 1, maxLength: 500 },
    cursor: { type: 'string', minLength: 1, maxLength: 500 },
    parameters: {
      type: 'object',
      maxProperties: 50,
      additionalProperties: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'number' }, { type: 'boolean' }] },
    },
  },
  required: ['sourceId'],
  additionalProperties: false,
} satisfies Record<string, unknown>

export function createQueryOptionsTool(host: ApiToolsHost): Tool {
  return {
    name: 'query_options',
    runtime: 'browser',
    skill: {
      description: '从已获授权的业务数据源查询标准 label/value 候选项。',
      triggers: ['options', 'dropdown', 'select', 'search', '候选项', '下拉', '查询'],
      content: guide,
    },
    inputSchema,
    async execute(args, ctx) {
      try {
        const result = await host.queryOptions(args as QueryOptionsInput, apiContext(ctx))
        return { ok: true, data: result }
      } catch (error) {
        return asToolError(error)
      }
    },
  }
}

export function registerApiTools(registry: ToolRegistry, host: ApiToolsHost): void {
  registry.register(createQueryOptionsTool(host))
}

function apiContext(ctx: ToolContext) {
  return { sessionId: ctx.sessionId, signal: ctx.signal }
}

function asToolError(error: unknown): ToolResult {
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
