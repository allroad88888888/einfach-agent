import { describe, expect, it, vi } from 'vitest'
import { EvaluationRuntime } from '@web-agent/core/evaluation/runtime'
import { PlanRuntime } from '@web-agent/core/planning/runtime'
import type { PlanSnapshot } from '@web-agent/core/planning/types'
import type { DelegateAgentBatchResult } from '@web-agent/core/subagents/types'
import type { ToolContext } from '@web-agent/core/tools/types'
import { submitStageResultTool } from './submit-stage-result'

function baseContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'session-1',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...overrides,
  }
}

describe('submit_stage_result tool', () => {
  it('schedules evaluation without blocking and advances the plan when the child finishes', async () => {
    let plan: PlanSnapshot | undefined
    let now = 0
    const store = {
      get: () => plan,
      set: (next: PlanSnapshot | undefined) => { plan = next },
    }
    const planning = new PlanRuntime(store, () => ++now, () => 'plan-1')
    const evaluation = new EvaluationRuntime(store, () => ++now)
    const created = planning.create({
      title: 'Delivery',
      objective: 'Ship safely',
      stages: [
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    let complete: ((result: DelegateAgentBatchResult) => unknown | Promise<unknown>) | undefined
    const spawnImplementation: NonNullable<ToolContext['spawnAgents']> = (_input, options) => {
      complete = options?.onComplete
      return {
        executionId: 'evaluation-node',
        graphId: 'run-1',
        nodeIds: ['evaluation-node'],
        status: 'scheduled',
      }
    }
    const spawnAgents = vi.fn(spawnImplementation)

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed'],
    }, baseContext({
      spawnAgents,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) =>
        evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(result).toMatchObject({
      ok: true,
      data: {
        plan: { status: 'active' },
        evaluation: { executionId: 'evaluation-node', status: 'scheduled' },
      },
    })
    expect(plan?.stages[0].status).toBe('evaluating')

    await complete?.({
      treeId: 'evaluation-run',
      conversationId: 'session-1',
      runId: 'evaluation-run',
      parentPath: 'root',
      strategy: 'parallel_wait_all',
      status: 'done',
      summary: { total: 1, done: 1, failed: 0, cancelled: 0 },
      cacheBasePath: '.agent-archive/conversations/session-1/runs/evaluation-run',
      archiveBasePath: '.agent-archive/conversations/session-1/runs/evaluation-run',
      eventLog: '.agent-archive/conversations/session-1/runs/evaluation-run/events.jsonl',
      skillFiles: [],
      skillIds: [],
      children: [{
        path: 'root/evaluator-1',
        objective: 'Evaluate',
        status: 'done',
        summary: JSON.stringify({
          criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
        }),
        skillFiles: [],
        skillIds: [],
      }],
    })

    expect(plan?.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('delegates evaluation and only advances after the independent verdict passes', async () => {
    let plan: PlanSnapshot | undefined
    let now = 0
    const store = {
      get: () => plan,
      set: (next: PlanSnapshot | undefined) => { plan = next },
    }
    const planning = new PlanRuntime(store, () => ++now, () => 'plan-1')
    const evaluation = new EvaluationRuntime(store, () => ++now)
    const created = planning.create({
      title: 'Delivery',
      objective: 'Ship safely',
      stages: [
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const delegateAgents = vi.fn(async (): Promise<DelegateAgentBatchResult> => ({
      treeId: 'evaluation-run',
      conversationId: 'session-1',
      runId: 'evaluation-run',
      parentPath: 'root',
      strategy: 'parallel_wait_all',
      status: 'done',
      summary: { total: 1, done: 1, failed: 0, cancelled: 0 },
      cacheBasePath: '.agent-archive/conversations/session-1/runs/evaluation-run',
      archiveBasePath: '.agent-archive/conversations/session-1/runs/evaluation-run',
      eventLog: '.agent-archive/conversations/session-1/runs/evaluation-run/events.jsonl',
      skillFiles: [],
      skillIds: [],
      budgetUsage: {
        totalNodes: { used: 1, limit: 1 },
        modelCalls: { used: 1, limit: 4 },
      },
      children: [{
        path: 'root/evaluator-1',
        objective: 'Evaluate',
        status: 'done',
        summary: JSON.stringify({
          criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
        }),
        skillFiles: [],
        skillIds: [],
      }],
    }))

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed'],
    }, baseContext({
      delegateAgents,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) => evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(delegateAgents).toHaveBeenCalledOnce()
    expect(delegateAgents).toHaveBeenCalledWith(expect.objectContaining({
      maxChildren: 6,
      maxConcurrent: 4,
      maxTotalNodes: 64,
      maxModelCalls: 128,
      children: [expect.objectContaining({ mode: 'evaluator', maxTurns: 12 })],
    }))
    expect(result).toMatchObject({ ok: true })
    expect(plan?.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('evaluator 请求失败时回滚 evaluating，使阶段可以重试', async () => {
    let plan: PlanSnapshot | undefined
    let now = 0
    const store = {
      get: () => plan,
      set: (next: PlanSnapshot | undefined) => { plan = next },
    }
    const planning = new PlanRuntime(store, () => ++now, () => 'plan-1')
    const evaluation = new EvaluationRuntime(store, () => ++now)
    const created = planning.create({
      title: 'Delivery',
      objective: 'Ship safely',
      stages: [{ id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass'] }],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['tests passed'],
    }, baseContext({
      delegateAgents: vi.fn(async () => { throw new Error('Load failed') }),
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) =>
        evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(result).toEqual({
      ok: false,
      error: 'automatic evaluation failed: Load failed',
      code: 'PLAN_EVALUATION_FAILED',
      retryable: true,
    })
    expect(plan?.stages[0]).toMatchObject({
      status: 'in_progress',
      evaluations: [{
        status: 'unknown',
        criteria: [{ criterion: 'tests pass', status: 'unknown', reason: 'Load failed' }],
      }],
    })
  })

  it('后台 evaluator 启动失败时回滚 evaluating，使阶段可以重试', async () => {
    let plan: PlanSnapshot | undefined
    let now = 0
    const store = {
      get: () => plan,
      set: (next: PlanSnapshot | undefined) => { plan = next },
    }
    const planning = new PlanRuntime(store, () => ++now, () => 'plan-1')
    const evaluation = new EvaluationRuntime(store, () => ++now)
    const created = planning.create({
      title: 'Delivery',
      objective: 'Ship safely',
      stages: [{ id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass'] }],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['tests passed'],
    }, baseContext({
      spawnAgents: vi.fn(() => { throw new Error('scheduler unavailable') }),
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) =>
        evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(result).toEqual({
      ok: false,
      error: 'automatic evaluation failed to start: scheduler unavailable',
      code: 'PLAN_EVALUATION_START_FAILED',
      retryable: true,
    })
    expect(plan?.stages[0]).toMatchObject({
      status: 'in_progress',
      evaluations: [{
        status: 'unknown',
        criteria: [{ criterion: 'tests pass', status: 'unknown', reason: 'scheduler unavailable' }],
      }],
    })
  })
})
