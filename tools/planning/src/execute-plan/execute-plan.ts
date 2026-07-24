import type { Tool } from '@web-agent/core/tools/types'
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
    properties: { planId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } },
    required: ['planId', 'revision'],
  },
  execute(args, ctx) {
    if (!ctx.executePlan) return { ok: false, error: 'execute_plan unavailable' }
    const input = args as { planId: string; revision: number }
    const result = ctx.executePlan(input.planId, input.revision)
    return result.ok ? { ok: true, data: result.plan } : result
  },
}
