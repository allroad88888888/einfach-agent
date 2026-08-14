import type { Tool } from '@web-agent/core/tools'
import guide from './execute-plan.md?raw'

export const executePlanTool: Tool = {
  name: 'execute_plan',
  runtime: 'internal',
  skill: {
    description: '启动或恢复已批准计划，并把下一个依赖就绪的阶段置为进行中。',
    triggers: ['execute plan', '执行计划', '开始阶段', '继续计划'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: { planId: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 1 } },
    required: ['planId', 'revision'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.executePlan) {
      return { ok: false, error: 'execute_plan unavailable', code: 'PLAN_UNAVAILABLE', retryable: false }
    }
    const input = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {}
    const planId = typeof input.planId === 'string' ? input.planId.trim() : ''
    const revision = input.revision
    if (!planId || !Number.isSafeInteger(revision) || (revision as number) < 1) {
      return {
        ok: false,
        error: 'invalid execute_plan: planId and a positive integer revision are required',
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
    try {
      const result = await ctx.executePlan(planId, revision as number)
      return result.ok
        ? { ok: true, data: result.plan }
        : { ok: false, error: result.error, code: 'PLAN_EXECUTE_REJECTED', retryable: false }
    } catch (error) {
      return {
        ok: false,
        error: `execute_plan failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
  },
}
