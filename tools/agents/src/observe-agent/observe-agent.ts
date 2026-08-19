import type { Tool } from '@einfach-agent/core/tools'
import guide from './observe-agent.md?raw'

export const observeAgentTool: Tool = {
  name: 'observe_agent',
  execution: { mode: 'parallel', effectKeys: ['execution:read'] },
  runtime: 'internal',
  skill: {
    description: '读取后台子 agent 执行状态，不等待完成。',
    triggers: ['observe agent', 'agent status', '子agent状态'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string', minLength: 1 },
    },
    required: ['executionId'],
    additionalProperties: false,
  },
  execute(args, ctx) {
    if (!ctx.observeExecution) {
      return {
        ok: false,
        error: '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。',
        code: 'AGENT_DELEGATION_UNAVAILABLE',
        retryable: false,
      }
    }
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {}
    const executionId = typeof input.executionId === 'string' ? input.executionId.trim() : ''
    if (!executionId) {
      return {
        ok: false,
        error: 'invalid observe_agent: executionId is required',
        code: 'AGENT_INVALID_EXECUTION_ID',
        retryable: false,
      }
    }
    let observation: ReturnType<typeof ctx.observeExecution>
    try {
      observation = ctx.observeExecution(executionId)
    } catch (error) {
      return {
        ok: false,
        error: `observe_agent failed: ${error instanceof Error ? error.message || error.name : String(error)}`,
        code: 'AGENT_OBSERVE_FAILED',
        retryable: true,
        details: { executionId },
      }
    }
    if (!observation.node) {
      return {
        ok: false,
        error: `unknown execution: ${executionId}`,
        code: 'AGENT_EXECUTION_UNKNOWN',
        retryable: false,
      }
    }
    return { ok: true, data: observation }
  },
}
