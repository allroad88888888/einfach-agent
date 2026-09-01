import { AgentHistoryError, type ListAgentHistoriesInput } from '@einfach-agent/core/history'
import type { Tool, ToolResult } from '@einfach-agent/core/tools'
import guide from './list-agent-histories.md?raw'

const targetSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { kind: { const: 'root' }, conversationId: { type: 'string', minLength: 1, maxLength: 1_000 } },
      required: ['kind', 'conversationId'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { const: 'child' }, conversationId: { type: 'string', minLength: 1, maxLength: 1_000 },
        runId: { type: 'string', minLength: 1, maxLength: 1_000 },
        agentPath: { type: 'string', minLength: 1, maxLength: 1_000 },
      },
      required: ['kind', 'conversationId', 'runId', 'agentPath'],
    },
  ],
}

function failure(error: unknown): ToolResult {
  if (error instanceof AgentHistoryError) {
    return { ok: false, error: error.message, code: error.code, retryable: false }
  }
  return {
    ok: false,
    error: `list_agent_histories failed: ${error instanceof Error ? error.message : String(error)}`,
    code: 'AGENT_HISTORY_QUERY_FAILED',
    retryable: true,
  }
}

export const listAgentHistoriesTool: Tool = {
  name: 'list_agent_histories',
  runtime: 'internal',
  execution: { mode: 'parallel', effectKeys: ['agent-history:read'] },
  skill: {
    description: '列出本机已保存的 root 或 child agent 历史。',
    triggers: ['agent history', '历史记录', '子agent历史'],
    content: guide,
  },
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      target: targetSchema,
      statuses: {
        type: 'array', maxItems: 11, uniqueItems: true,
        items: { type: 'string', enum: ['idle', 'running', 'awaiting_tool', 'waiting_user',
          'waiting_confirmation', 'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error', 'legacy'] },
      },
      cursor: { type: 'string', minLength: 1, maxLength: 100_000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  async execute(args, ctx) {
    if (!ctx.agentHistory) {
      return { ok: false, error: 'Agent history is unavailable in this runtime.',
        code: 'AGENT_HISTORY_UNAVAILABLE', retryable: false }
    }
    try {
      return { ok: true, data: await ctx.agentHistory.listHistories(args as ListAgentHistoriesInput) }
    } catch (error) {
      return failure(error)
    }
  },
}
