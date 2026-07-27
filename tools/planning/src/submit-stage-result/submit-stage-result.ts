import type { SubmitStageResultInput } from '@web-agent/core/planning/types'
import type { Tool } from '@web-agent/core/tools/types'
import guide from './submit-stage-result.md?raw'

export const submitStageResultTool: Tool = {
  name: 'submit_stage_result',
  runtime: 'internal',
  skill: {
    description: '提交当前阶段的产出与证据，进入逐条验收评估；提交本身不能完成阶段。',
    triggers: ['submit stage result', '提交阶段结果', '阶段待评估'],
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
  async execute(args, ctx) {
    if (!ctx.submitStageResult) {
      return { ok: false, error: 'submit_stage_result unavailable', code: 'PLAN_UNAVAILABLE', retryable: false }
    }
    if ((!ctx.spawnAgents && !ctx.delegateAgents) || !ctx.evaluateStage || !ctx.evaluatePlan || !ctx.abortStageEvaluation) {
      return {
        ok: false,
        error: 'automatic evaluator unavailable',
        code: 'PLAN_EVALUATOR_UNAVAILABLE',
        retryable: false,
      }
    }
    const input = args as unknown as SubmitStageResultInput
    let submitted
    try {
      submitted = ctx.submitStageResult(input)
    } catch (error) {
      return {
        ok: false,
        error: `submit_stage_result failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'PLAN_INVALID_INPUT',
        retryable: false,
      }
    }
    if (!submitted.ok) {
      return {
        ok: false,
        error: submitted.error,
        code: 'PLAN_STAGE_SUBMISSION_REJECTED',
        retryable: false,
      }
    }
    const stage = submitted.plan.stages.find((item) => item.id === input.stageId)!
    const isFinalStage = submitted.plan.stages.every((item) => item.id === stage.id || item.status === 'completed' || item.status === 'skipped')
    const evaluatorInput = {
      strategy: 'parallel_wait_all' as const,
      // 这是整次主 run 共用的根预算，不是“本次只启动几个 evaluator”。若这里都写 1，
      // 根节点本身已经占掉唯一 node，首个 evaluator 必然报 used 1 of 1；即使偶发失败，
      // 后续重试也永远没有额度。保持树级默认容量，单次评估仍由 children/maxTurns 限成 1×12。
      maxChildren: 6,
      maxConcurrent: 4,
      maxTotalNodes: 64,
      maxModelCalls: 128,
      toolProfile: 'workspace_read' as const,
      children: [{
        mode: 'evaluator',
        objective: [
          'Act as an independent evaluator. Do not implement or modify anything.',
          `Plan objective: ${submitted.plan.objective}`,
          `Stage objective: ${stage.objective}`,
          `Acceptance criteria: ${JSON.stringify(stage.acceptanceCriteria)}`,
          `Submitted summary: ${input.summary}`,
          `Submitted evidence: ${JSON.stringify(input.evidence)}`,
          'Inspect the workspace when useful. Return ONLY one JSON object.',
          'Use the read-only tools efficiently. Finish the inspection before the reserved final synthesis turn.',
          'Schema: {"criteria":[{"criterion":"exact criterion text","status":"passed|failed|unknown","evidence":["concrete evidence"],"reason":"reason or empty"}]',
          isFinalStage
            ? ',"final":{"status":"passed|failed|unknown","evidence":["integration/regression/goal evidence"],"reason":"reason or empty","requiresUserAcceptance":boolean}}'
            : '}',
          'Cover every criterion exactly once. Passed requires evidence; failed/unknown requires reason.',
        ].join('\n'),
        expectedOutput: 'Strict JSON evaluation only',
        maxTurns: 12,
        toolProfile: 'workspace_read' as const,
      }],
    }

    const applyEvaluation = (result: Awaited<ReturnType<NonNullable<typeof ctx.delegateAgents>>>) => {
      const child = result.children[0]
      if (!child || child.status !== 'done') throw new Error(child?.error || 'evaluator did not finish')
      const evaluation = parseEvaluation(child.summary)
      if (isFinalStage && !evaluation.final) throw new Error('final evaluation is required for the last stage')
      validateEvaluationPayload(evaluation, stage.acceptanceCriteria, isFinalStage)
      const stageResult = ctx.evaluateStage!({
        planId: submitted.plan.id,
        revision: submitted.plan.revision,
        stageId: stage.id,
        criteria: evaluation.criteria,
      })
      if (!stageResult.ok) throw new Error(stageResult.error)
      if (stageResult.plan.status !== 'evaluating') return stageResult.plan
      const final = evaluation.final!
      const planResult = ctx.evaluatePlan!({
        planId: stageResult.plan.id,
        revision: stageResult.plan.revision,
        ...final,
      })
      if (!planResult.ok) throw new Error(planResult.error)
      return planResult.plan
    }

    const rollbackEvaluation = (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      const rollback = ctx.abortStageEvaluation!(
        submitted.plan.id,
        submitted.plan.revision,
        stage.id,
        reason,
      )
      if (!rollback.ok) {
        throw new Error(`automatic evaluation failed: ${reason}; evaluation rollback failed: ${rollback.error}`)
      }
    }

    // Production path: evaluator becomes a child execution node. The tool
    // result is returned immediately, while completion advances the Plan via
    // its revision-guarded state machine.
    if (ctx.spawnAgents) {
      try {
        const evaluation = ctx.spawnAgents(evaluatorInput, {
          onComplete: applyEvaluation,
          onError: rollbackEvaluation,
        })
        return {
          ok: true,
          data: {
            plan: submitted.plan,
            evaluation,
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        try {
          rollbackEvaluation(error)
        } catch (rollbackError) {
          return {
            ok: false,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            code: 'PLAN_EVALUATION_ROLLBACK_FAILED',
            retryable: false,
          }
        }
        return {
          ok: false,
          error: `automatic evaluation failed to start: ${reason}`,
          code: 'PLAN_EVALUATION_START_FAILED',
          retryable: true,
        }
      }
    }

    // Compatibility path for hosts/tests that have not installed the
    // background execution runtime yet.
    try {
      const result = await ctx.delegateAgents!(evaluatorInput)
      return { ok: true, data: applyEvaluation(result) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try {
        rollbackEvaluation(error)
      } catch (rollbackError) {
        return {
          ok: false,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          code: 'PLAN_EVALUATION_ROLLBACK_FAILED',
          retryable: false,
        }
      }
      return {
        ok: false,
        error: `automatic evaluation failed: ${reason}`,
        code: 'PLAN_EVALUATION_FAILED',
        retryable: true,
      }
    }
  },
}

interface ParsedEvaluation {
  criteria: Array<{ criterion: string; status: 'passed' | 'failed' | 'unknown'; evidence: string[]; reason: string }>
  final?: { status: 'passed' | 'failed' | 'unknown'; evidence?: string[]; reason?: string; requiresUserAcceptance?: boolean }
}

function parseEvaluation(text: string): ParsedEvaluation {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const value = JSON.parse(source) as ParsedEvaluation
  if (!value || !Array.isArray(value.criteria)) throw new Error('evaluator returned invalid criteria')
  return value
}

function validateEvaluationPayload(value: ParsedEvaluation, expectedCriteria: string[], finalRequired: boolean): void {
  const verdicts = new Set(['passed', 'failed', 'unknown'])
  if (value.criteria.length !== expectedCriteria.length) throw new Error('evaluator must cover every criterion')
  const seen = new Set<string>()
  for (const item of value.criteria) {
    if (!expectedCriteria.includes(item.criterion) || seen.has(item.criterion)) throw new Error('evaluator returned unknown or duplicate criterion')
    if (!verdicts.has(item.status) || !Array.isArray(item.evidence) || typeof item.reason !== 'string') throw new Error('evaluator returned malformed criterion result')
    seen.add(item.criterion)
  }
  if (!finalRequired) return
  const final = value.final
  if (!final || !verdicts.has(final.status) || (final.evidence !== undefined && !Array.isArray(final.evidence)) || (final.reason !== undefined && typeof final.reason !== 'string')) {
    throw new Error('evaluator returned malformed final result')
  }
  if (final.status === 'passed' && !final.evidence?.some((item) => item.trim())) throw new Error('passed final evaluation requires evidence')
  if (final.status !== 'passed' && !final.reason?.trim()) throw new Error(`${final.status} final evaluation requires reason`)
}
