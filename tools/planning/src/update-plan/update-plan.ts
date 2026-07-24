import type { UpdatePlanInput } from '@web-agent/core/planning/types'
import type { Tool } from '@web-agent/core/tools/types'
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
      planId: { type: 'string' },
      revision: { type: 'integer', minimum: 1 },
      stageId: { type: 'string' },
      status: { type: 'string', enum: ['blocked'] },
      evidence: { type: 'array', items: { type: 'string' } },
      blockReason: { type: 'string' },
    },
    required: ['planId', 'revision', 'stageId', 'status'],
  },
  execute(args, ctx) {
    if (!ctx.updatePlan) return { ok: false, error: 'update_plan unavailable' }
    const result = ctx.updatePlan(args as unknown as UpdatePlanInput)
    return result.ok ? { ok: true, data: result.plan } : result
  },
}
