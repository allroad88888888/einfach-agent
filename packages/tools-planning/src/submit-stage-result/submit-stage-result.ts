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
      planId: { type: 'string' },
      revision: { type: 'integer', minimum: 1 },
      stageId: { type: 'string' },
      summary: { type: 'string' },
      evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
    required: ['planId', 'revision', 'stageId', 'summary', 'evidence'],
  },
  async execute(args, ctx) {
    if (!ctx.submitStageResult) return { ok: false, error: 'submit_stage_result unavailable' }
    if (!ctx.delegateAgents || !ctx.evaluateStage || !ctx.evaluatePlan || !ctx.abortStageEvaluation) {
      return { ok: false, error: 'automatic evaluator unavailable' }
    }
    const input = args as unknown as SubmitStageResultInput
    const submitted = ctx.submitStageResult(input)
    if (!submitted.ok) return submitted
    const stage = submitted.plan.stages.find((item) => item.id === input.stageId)!
    const isFinalStage = submitted.plan.stages.every((item) => item.id === stage.id || item.status === 'completed' || item.status === 'skipped')
    try {
      const result = await ctx.delegateAgents({
        strategy: 'parallel_wait_all',
        maxChildren: 1,
        maxConcurrent: 1,
        maxTotalNodes: 1,
        maxModelCalls: 4,
        toolProfile: 'workspace_read',
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
            'Schema: {"criteria":[{"criterion":"exact criterion text","status":"passed|failed|unknown","evidence":["concrete evidence"],"reason":"reason or empty"}]',
            isFinalStage
              ? ',"final":{"status":"passed|failed|unknown","evidence":["integration/regression/goal evidence"],"reason":"reason or empty","requiresUserAcceptance":boolean}}'
              : '}',
            'Cover every criterion exactly once. Passed requires evidence; failed/unknown requires reason.',
          ].join('\n'),
          expectedOutput: 'Strict JSON evaluation only',
          maxTurns: 4,
          toolProfile: 'workspace_read',
        }],
      })
      const child = result.children[0]
      if (!child || child.status !== 'done') throw new Error(child?.error || 'evaluator did not finish')
      const evaluation = parseEvaluation(child.summary)
      if (isFinalStage && !evaluation.final) throw new Error('final evaluation is required for the last stage')
      validateEvaluationPayload(evaluation, stage.acceptanceCriteria, isFinalStage)
      const stageResult = ctx.evaluateStage({
        planId: submitted.plan.id,
        revision: submitted.plan.revision,
        stageId: stage.id,
        criteria: evaluation.criteria,
      })
      if (!stageResult.ok) throw new Error(stageResult.error)
      if (stageResult.plan.status !== 'evaluating') return { ok: true, data: stageResult.plan }
      const final = evaluation.final!
      const planResult = ctx.evaluatePlan({
        planId: stageResult.plan.id,
        revision: stageResult.plan.revision,
        ...final,
      })
      if (!planResult.ok) throw new Error(planResult.error)
      return { ok: true, data: planResult.plan }
    } catch (error) {
      const latestRevision = submitted.plan.revision
      ctx.abortStageEvaluation(submitted.plan.id, latestRevision, stage.id, error instanceof Error ? error.message : String(error))
      return { ok: false, error: `automatic evaluation failed: ${error instanceof Error ? error.message : String(error)}` }
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
