import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import type { ListOptionsSourcesInput, ApiToolsHost } from '../options-host'
import { asToolError } from '../tool-error'
import guide from './list-options-sources.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>

/** Lists only source metadata that the current session is authorized to discover. */
export function createListOptionsSourcesTool(host: ApiToolsHost): Tool {
  return {
    name: 'list_options_sources',
    runtime: 'browser',
    skill: {
      description: '列出当前会话获授权的业务选项数据源，供 query_options 选择 sourceId。',
      triggers: ['options', 'source', 'dropdown', '候选项', '数据源', '下拉'],
      content: guide,
    },
    inputSchema,
    async execute(args, ctx) {
      if (!host.listSources) return asToolError(new Error('list_options_sources is unavailable'))
      try {
        const result = await host.listSources(args as ListOptionsSourcesInput, apiContext(ctx))
        return { ok: true, data: result }
      } catch (error) {
        return asToolError(error)
      }
    },
  }
}

function apiContext(ctx: ToolContext) {
  return { sessionId: ctx.sessionId, signal: ctx.signal }
}
