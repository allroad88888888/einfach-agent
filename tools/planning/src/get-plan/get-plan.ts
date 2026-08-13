import type { Tool } from '@web-agent/core/tools'
import guide from './get-plan.md?raw'

export const getPlanTool: Tool = {
  name: 'get_plan',
  execution: { mode: 'parallel', effectKeys: ['plan:read'] },
  runtime: 'internal',
  skill: {
    description: '读取当前会话的结构化计划、最新 revision 和各阶段状态。',
    triggers: ['get plan', '查看计划', '计划状态', '当前阶段', 'revision'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute(_args, ctx) {
    if (!ctx.getPlan) {
      return {
        ok: false,
        error: 'get_plan unavailable: plan state is not configured',
        code: 'PLAN_UNAVAILABLE',
        retryable: false,
      }
    }
    let plan: ReturnType<NonNullable<typeof ctx.getPlan>>
    try {
      plan = ctx.getPlan()
    } catch (error) {
      return {
        ok: false,
        error: `get_plan failed: ${error instanceof Error ? error.message || error.name : String(error)}`,
        code: 'PLAN_READ_FAILED',
        retryable: true,
      }
    }
    if (!plan) {
      return {
        ok: false,
        error: 'no plan exists in the current session',
        code: 'PLAN_NOT_FOUND',
        retryable: false,
        hint: 'Create one with create_plan before calling get_plan.',
      }
    }
    return { ok: true, data: plan }
  },
}
