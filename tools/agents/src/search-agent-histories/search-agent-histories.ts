import { AgentHistoryError, type SearchAgentHistoriesInput } from '@einfach-agent/core/history'
import type { Tool, ToolResult } from '@einfach-agent/core/tools'
import guide from './search-agent-histories.md?raw'

const targetSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false,
      properties: { kind: { const: 'root' }, conversationId: { type: 'string', minLength: 1, maxLength: 1_000 } },
      required: ['kind', 'conversationId'] },
    { type: 'object', additionalProperties: false,
      properties: {
        kind: { const: 'child' }, conversationId: { type: 'string', minLength: 1, maxLength: 1_000 },
        runId: { type: 'string', minLength: 1, maxLength: 1_000 },
        agentPath: { type: 'string', minLength: 1, maxLength: 1_000 },
      }, required: ['kind', 'conversationId', 'runId', 'agentPath'] },
  ],
}

function failure(error: unknown): ToolResult {
  return error instanceof AgentHistoryError
    ? { ok: false, error: error.message, code: error.code, retryable: false }
    : { ok: false, error: `search_agent_histories failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'AGENT_HISTORY_QUERY_FAILED', retryable: true }
}

export const searchAgentHistoriesTool: Tool = {
  name: 'search_agent_histories', runtime: 'internal',
  execution: { mode: 'parallel', effectKeys: ['agent-history:read'] },
  skill: { description: '全文搜索本机 agent 历史。',
    triggers: ['search agent history', '搜索历史', 'find prior agent work'], content: guide },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 1_000 },
      target: targetSchema,
      roles: { type: 'array', maxItems: 4, uniqueItems: true,
        items: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] } },
      cursor: { type: 'string', minLength: 1, maxLength: 100_000 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    if (!ctx.agentHistory) return { ok: false, error: 'Agent history is unavailable in this runtime.',
      code: 'AGENT_HISTORY_UNAVAILABLE', retryable: false }
    try { return { ok: true, data: await ctx.agentHistory.search(args as SearchAgentHistoriesInput) } }
    catch (error) { return failure(error) }
  },
}
