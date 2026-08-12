import type { Tool } from '@web-agent/core/tools/types'
import guide from './join-agent.md?raw'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000

export const joinAgentTool: Tool = {
  name: 'join_agent',
  execution: { mode: 'parallel', effectKeys: ['execution:read'] },
  runtime: 'internal',
  skill: {
    description: '显式等待一个后台子 agent 执行并取得结果。',
    triggers: ['join agent', 'wait agent', '等待子agent'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string', minLength: 1 },
      timeoutMs: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
      },
    },
    required: ['executionId'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.joinExecution) {
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
        error: 'invalid join_agent: executionId is required',
        code: 'AGENT_INVALID_EXECUTION_ID',
        retryable: false,
      }
    }
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.min(Math.max(Math.floor(input.timeoutMs), 0), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS
    let result
    try {
      result = await ctx.joinExecution(executionId, timeoutMs)
    } catch (error) {
      const message = error instanceof Error ? error.message || error.name : String(error)
      return {
        ok: false,
        error: `join_agent failed: ${message}`,
        code: 'AGENT_JOIN_FAILED',
        hint: 'Call observe_agent to check whether the execution still exists before retrying.',
        retryable: true,
        details: { executionId },
      }
    }
    if (result.timedOut) {
      return {
        ok: false,
        error: `join_agent timed out after ${timeoutMs}ms: ${executionId}`,
        code: 'AGENT_JOIN_TIMEOUT',
        hint: 'Continue independent work, then call observe_agent or join_agent again.',
        retryable: true,
        details: result,
      }
    }
    if (result.status === 'failed') {
      return {
        ok: false,
        error: result.error ?? `execution failed: ${executionId}`,
        code: 'AGENT_EXECUTION_FAILED',
        retryable: false,
        details: result,
      }
    }
    if (result.status === 'cancelled') {
      return {
        ok: false,
        error: result.error ?? `execution cancelled: ${executionId}`,
        code: 'AGENT_EXECUTION_CANCELLED',
        retryable: false,
        details: result,
      }
    }
    if (result.status !== 'succeeded') {
      return {
        ok: false,
        error: `execution did not reach a terminal result: ${executionId} is ${result.status}`,
        code: 'AGENT_EXECUTION_INCOMPLETE',
        hint: 'Call observe_agent for the latest state, or join_agent again with a positive timeout.',
        retryable: true,
        details: result,
      }
    }
    return { ok: true, data: result }
  },
}
