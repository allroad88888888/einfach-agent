import type { Tool, ToolContext, ToolRegistry } from '@einfach-agent/core/tools'
import { createListOptionsSourcesTool } from '../list-options-sources/list-options-sources'
import type { ApiToolsHost, QueryOptionsInput } from '../options-host'
import { asToolError } from '../tool-error'
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
  if (host.listSources) registry.register(createListOptionsSourcesTool(host))
}

function apiContext(ctx: ToolContext) {
  return { sessionId: ctx.sessionId, signal: ctx.signal }
}
