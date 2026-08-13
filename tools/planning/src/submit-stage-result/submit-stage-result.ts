import type { SubmitStageResultInput } from '@web-agent/core/planning'
import type { Tool } from '@web-agent/core/tools'
import guide from './submit-stage-result.md?raw'

export const submitStageResultTool: Tool = {
  name: 'submit_stage_result',
  runtime: 'internal',
  skill: {
    description: '提交当前阶段的产出与证据，完成该阶段并激活下一个依赖就绪的阶段。',
    triggers: ['submit stage result', '提交阶段结果', '阶段完成'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1 },
      revision: { type: 'integer', minimum: 1 },
      stageId: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1 },
      evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    },
    required: ['planId', 'revision', 'stageId', 'summary', 'evidence'],
    additionalProperties: false,
  },
  execute(args, ctx) {
    if (!ctx.submitStageResult) {
      return { ok: false, error: 'submit_stage_result unavailable', code: 'PLAN_UNAVAILABLE', retryable: false }
    }
    let result
    try {
      result = ctx.submitStageResult(args as unknown as SubmitStageResultInput)
    } catch (error) {
      return {
        ok: false,
        error: `submit_stage_result failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: 'PLAN_STAGE_SUBMISSION_REJECTED',
        retryable: false,
      }
    }
    return { ok: true, data: result.plan }
  },
}
