import {
  AGENT_HISTORY_CURSOR_MAX_CHARS, AGENT_HISTORY_ITEM_ROLES, AGENT_HISTORY_LIST_MAX_LIMIT,
  AGENT_HISTORY_QUERY_TARGET_MAX_CHARS, AgentHistoryError, agentHistoryTargetJsonSchema,
  type ListAgentHistoryItemsInput,
} from '@einfach-agent/core/history'
import type { Tool, ToolResult } from '@einfach-agent/core/tools'
import guide from './list-agent-history-items.md?raw'

const targetSchema = agentHistoryTargetJsonSchema(AGENT_HISTORY_QUERY_TARGET_MAX_CHARS)

function failure(error: unknown): ToolResult {
  return error instanceof AgentHistoryError
    ? { ok: false, error: error.message, code: error.code, retryable: false }
    : { ok: false, error: `list_agent_history_items failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'AGENT_HISTORY_QUERY_FAILED', retryable: true }
}

export const listAgentHistoryItemsTool: Tool = {
  name: 'list_agent_history_items', runtime: 'internal',
  execution: { mode: 'parallel', effectKeys: ['agent-history:read'] },
  skill: { description: '列出一个本机 agent 历史中的条目摘要。',
    triggers: ['history items', '历史条目', 'agent messages'], content: guide },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      target: targetSchema,
      roles: { type: 'array', maxItems: AGENT_HISTORY_ITEM_ROLES.length, uniqueItems: true,
        items: { type: 'string', enum: AGENT_HISTORY_ITEM_ROLES } },
      includeDeleted: { type: 'boolean' },
      cursor: { type: 'string', minLength: 1, maxLength: AGENT_HISTORY_CURSOR_MAX_CHARS },
      limit: { type: 'integer', minimum: 1, maximum: AGENT_HISTORY_LIST_MAX_LIMIT },
    },
    required: ['target'],
  },
  async execute(args, ctx) {
    if (!ctx.agentHistory) return { ok: false, error: 'Agent history is unavailable in this runtime.',
      code: 'AGENT_HISTORY_UNAVAILABLE', retryable: false }
    try { return { ok: true, data: await ctx.agentHistory.listItems(args as ListAgentHistoryItemsInput) } }
    catch (error) { return failure(error) }
  },
}
