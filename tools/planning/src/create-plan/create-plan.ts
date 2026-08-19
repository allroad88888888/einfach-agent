import type { CreatePlanInput } from '@einfach-agent/core/planning'
import type { Tool } from '@einfach-agent/core/tools'
import guide from './create-plan.md?raw'

const stageProperties = {
  id: { type: 'string', minLength: 1 },
  title: { type: 'string', minLength: 1 },
  objective: { type: 'string', minLength: 1 },
  deliverables: { type: 'array', items: { type: 'string', minLength: 1 } },
  dependencies: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
}

export const createPlanTool: Tool = {
  name: 'create_plan',
  runtime: 'internal',
  skill: {
    description: '创建带依赖、交付物和审批策略的结构化分阶段计划。',
    triggers: ['plan', '规划', '阶段', '复杂任务', '多步骤'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1 },
      objective: { type: 'string', minLength: 1 },
      approvalMode: { type: 'string', enum: ['auto', 'required'], default: 'auto' },
      stages: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: stageProperties,
          required: ['id', 'title', 'objective'],
        },
      },
    },
    required: ['title', 'objective', 'stages'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.createPlan) {
      return { ok: false, error: 'create_plan unavailable', code: 'PLAN_UNAVAILABLE', retryable: false }
    }
    let result
    try {
      result = await ctx.createPlan(args as unknown as CreatePlanInput)
    } catch (error) {
      return {
        ok: false,
        error: `create_plan failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: 'PLAN_CREATE_REJECTED',
        retryable: false,
      }
    }
    if (result.plan.status === 'awaiting_approval') {
      return { pause: { kind: 'plan_approval', planId: result.plan.id, revision: result.plan.revision } }
    }
    return { ok: true, data: result.plan }
  },
}
