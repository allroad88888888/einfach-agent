import type { Tool } from '@web-agent/core/tools/types'
import guide from './cancel-agent.md?raw'

export const cancelAgentTool: Tool = {
  name: 'cancel_agent',
  execution: { mode: 'serial', effectKeys: ['execution:write'] },
  runtime: 'internal',
  skill: {
    description: '取消仍在运行的后台子 agent 执行。',
    triggers: ['cancel agent', 'stop agent', '取消子agent', '停止子agent'],
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
    if (!ctx.cancelExecution) {
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
        error: 'invalid cancel_agent: executionId is required',
        code: 'AGENT_INVALID_EXECUTION_ID',
        retryable: false,
      }
    }

    let cancelled: boolean
    let observation: ReturnType<NonNullable<typeof ctx.observeExecution>> | undefined
    try {
      cancelled = ctx.cancelExecution(executionId)
      observation = ctx.observeExecution?.(executionId)
    } catch (error) {
      return {
        ok: false,
        error: `cancel_agent failed: ${error instanceof Error ? error.message || error.name : String(error)}`,
        code: 'AGENT_CANCEL_FAILED',
        retryable: true,
        details: { executionId },
      }
    }
    if (!cancelled && !observation?.node) {
      return {
        ok: false,
        error: `unknown execution: ${executionId}`,
        code: 'AGENT_EXECUTION_UNKNOWN',
        retryable: false,
      }
    }
    return {
      ok: true,
      data: {
        executionId,
        cancelled,
        status: observation?.node?.status,
      },
    }
  },
}
