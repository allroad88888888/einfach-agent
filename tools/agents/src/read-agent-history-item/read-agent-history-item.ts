import {
  AGENT_HISTORY_QUERY_ITEM_ID_MAX_CHARS, AGENT_HISTORY_QUERY_TARGET_MAX_CHARS,
  AGENT_HISTORY_READ_MAX_LIMIT,
  AgentHistoryError, agentHistoryTargetJsonSchema, type ReadAgentHistoryItemInput,
} from '@einfach-agent/core/history'
import type { Tool, ToolResult } from '@einfach-agent/core/tools'
import guide from './read-agent-history-item.md?raw'

const targetSchema = agentHistoryTargetJsonSchema(AGENT_HISTORY_QUERY_TARGET_MAX_CHARS)

function failure(error: unknown): ToolResult {
  return error instanceof AgentHistoryError
    ? { ok: false, error: error.message, code: error.code, retryable: false }
    : { ok: false, error: `read_agent_history_item failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'AGENT_HISTORY_QUERY_FAILED', retryable: true }
}

export const readAgentHistoryItemTool: Tool = {
  name: 'read_agent_history_item', runtime: 'internal',
  execution: { mode: 'parallel', effectKeys: ['agent-history:read'] },
  skill: { description: '分段读取一个本机 agent 历史条目的稳定 JSON 文本。',
    triggers: ['read history item', '读取历史条目', 'agent message content'], content: guide },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      target: targetSchema,
      itemId: { type: 'string', minLength: 1, maxLength: AGENT_HISTORY_QUERY_ITEM_ID_MAX_CHARS },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: AGENT_HISTORY_READ_MAX_LIMIT },
    },
    required: ['target', 'itemId'],
  },
  async execute(args, ctx) {
    if (!ctx.agentHistory) return { ok: false, error: 'Agent history is unavailable in this runtime.',
      code: 'AGENT_HISTORY_UNAVAILABLE', retryable: false }
    try { return { ok: true, data: await ctx.agentHistory.readItem(args as ReadAgentHistoryItemInput) } }
    catch (error) { return failure(error) }
  },
}
