import type { CreatePlanInput } from '@web-agent/core/planning/types'
import type { Tool } from '@web-agent/core/tools/types'
import guide from './create-plan.md?raw'

const stageProperties = {
  id: { type: 'string' },
  title: { type: 'string' },
  objective: { type: 'string' },
  deliverables: { type: 'array', items: { type: 'string' } },
  acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } },
  dependencies: { type: 'array', uniqueItems: true, items: { type: 'string' } },
}

export const createPlanTool: Tool = {
  name: 'create_plan',
  runtime: 'internal',
  skill: {
    description: '创建带依赖、验收标准和审批策略的结构化分阶段计划。',
    triggers: ['plan', '规划', '阶段', '复杂任务', '多步骤'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      objective: { type: 'string' },
      approvalMode: { type: 'string', enum: ['auto', 'required'], default: 'auto' },
      stages: {
        type: 'array', minItems: 1,
        items: { type: 'object', properties: stageProperties, required: ['id', 'title', 'objective', 'acceptanceCriteria'] },
      },
    },
    required: ['title', 'objective', 'stages'],
  },
  execute(args, ctx) {
    if (!ctx.createPlan) return { ok: false, error: 'create_plan unavailable' }
    const result = ctx.createPlan(args as unknown as CreatePlanInput)
    if (!result.ok) return result
    if (result.plan.status === 'awaiting_approval') {
      return { pause: { kind: 'plan_approval', planId: result.plan.id, revision: result.plan.revision } }
    }
    return { ok: true, data: result.plan }
  },
}
