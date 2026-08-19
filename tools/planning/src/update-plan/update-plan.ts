import type { UpdatePlanInput } from '@einfach-agent/core/planning'
import type { Tool } from '@einfach-agent/core/tools'
import guide from './update-plan.md?raw'

export const updatePlanTool: Tool = {
  name: 'update_plan',
  runtime: 'internal',
  skill: {
    description: '记录当前计划阶段的阻塞原因；完成与跳过只能由宿主 Evaluation 判定。',
    triggers: ['update plan', '更新计划', '阶段阻塞'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1 },
      revision: { type: 'integer', minimum: 1 },
      stageId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['blocked'] },
      evidence: { type: 'array', items: { type: 'string', minLength: 1 } },
      blockReason: { type: 'string', minLength: 1 },
    },
    required: ['planId', 'revision', 'stageId', 'status'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.updatePlan) {
      return { ok: false, error: 'update_plan unavailable', code: 'PLAN_UNAVAILABLE', retryable: false }
    }
    try {
      const result = await ctx.updatePlan(args as unknown as UpdatePlanInput)
      return result.ok
        ? { ok: true, data: result.plan }
        : { ok: false, error: result.error, code: 'PLAN_UPDATE_REJECTED', retryable: false }
    } catch (error) {
      return {
        ok: false,
        error: `update_plan failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
  },
}
