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

function evaluatorResult(payload: unknown): DelegateAgentBatchResult {
  return {
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
      summary: JSON.stringify(payload),
      skillFiles: [],
      skillIds: [],
    }],
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

    let evaluatorInput: Parameters<NonNullable<ToolContext['delegateAgents']>>[0] | undefined
    const delegateAgents = vi.fn(async (input: Parameters<NonNullable<ToolContext['delegateAgents']>>[0]): Promise<DelegateAgentBatchResult> => {
      evaluatorInput = input
      return {
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
      }
    })
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        commands: [{ kind: 'test', argv: ['pnpm', 'test'], cwd: '.', origin: 'declared', evidence: 'package.json', confidence: 'high' }],
        warnings: [],
      },
    })

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed'],
    }, baseContext({
      delegateAgents,
      callTool,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) => evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(delegateAgents).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledWith('find_test_lint_commands', {})
    expect(delegateAgents).toHaveBeenCalledWith(expect.objectContaining({
      maxChildren: 6,
      maxConcurrent: 4,
      maxTotalNodes: 64,
      maxModelCalls: 128,
      children: [expect.objectContaining({ mode: 'evaluator', maxTurns: 12 })],
    }))
    if (!evaluatorInput) throw new Error('missing evaluator input')
    expect(evaluatorInput.children[0].objective).toContain('"argv":["pnpm","test"]')
    expect(result).toMatchObject({ ok: true })
    expect(plan?.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('sends one corrective evaluator request when a valid response misses criteria', async () => {
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
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass', 'lint passes'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const delegateAgents = vi.fn()
      .mockResolvedValueOnce(evaluatorResult({
        criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
      }))
      .mockResolvedValueOnce(evaluatorResult({
        criteria: [
          { criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' },
          { criterion: 'lint passes', status: 'passed', evidence: ['lint clean'], reason: '' },
        ],
      }))
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        commands: [{ kind: 'lint', argv: ['pnpm', 'lint'], cwd: '.', origin: 'declared', evidence: 'package.json', confidence: 'high' }],
        warnings: [],
      },
    })

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed', 'lint clean'],
    }, baseContext({
      delegateAgents,
      callTool,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) => evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(result).toMatchObject({ ok: true })
    expect(callTool).toHaveBeenCalledOnce()
    expect(delegateAgents).toHaveBeenCalledTimes(2)
    expect(delegateAgents.mock.calls[0][0].children[0].objective).toContain('"argv":["pnpm","lint"]')
    expect(delegateAgents.mock.calls[1][0].children[0].objective).toContain('Missing criteria: ["lint passes"]')
    expect(delegateAgents.mock.calls[1][0].children[0].objective).toContain('COMPLETE replacement evaluation')
    expect(delegateAgents.mock.calls[1][0].children[0].objective).toContain('"argv":["pnpm","lint"]')
    expect(plan?.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('schedules one corrective evaluator request in the background path', async () => {
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
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass', 'lint passes'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const completions: Array<(result: DelegateAgentBatchResult) => unknown | Promise<unknown>> = []
    const spawnAgents = vi.fn((_input, options) => {
      if (!options?.onComplete) throw new Error('missing completion callback')
      completions.push(options.onComplete)
      return { executionId: `evaluation-${completions.length}`, graphId: 'run-1', nodeIds: [], status: 'scheduled' as const }
    })

    await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['3 tests passed', 'lint clean'],
    }, baseContext({
      spawnAgents,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) => evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    await completions[0](evaluatorResult({
      criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
    }))
    expect(spawnAgents).toHaveBeenCalledTimes(2)
    expect(plan?.stages[0].status).toBe('evaluating')

    await completions[1](evaluatorResult({
      criteria: [
        { criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' },
        { criterion: 'lint passes', status: 'passed', evidence: ['lint clean'], reason: '' },
      ],
    }))
    expect(plan?.stages.map((stage) => stage.status)).toEqual(['completed', 'in_progress'])
  })

  it('rolls back after the one corrective request is still incomplete', async () => {
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
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass', 'lint passes'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const delegateAgents = vi.fn()
      .mockResolvedValueOnce(evaluatorResult({
        criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
      }))
      .mockResolvedValueOnce(evaluatorResult({
        criteria: [{ criterion: 'tests pass', status: 'passed', evidence: ['3 tests passed'], reason: '' }],
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

    expect(delegateAgents).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      ok: false,
      error: 'automatic evaluation failed: evaluator repair failed after initial result covered 1/2 criteria: evaluator must cover every criterion',
    })
    expect(plan?.stages[0]).toMatchObject({ status: 'in_progress', evaluations: [{ status: 'unknown' }] })
  })

  it('does not repair an incomplete response with an unknown criterion', async () => {
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
        { id: 'build', title: 'Build', objective: 'Implement', acceptanceCriteria: ['tests pass', 'lint passes'] },
        { id: 'release', title: 'Release', objective: 'Package', acceptanceCriteria: ['build passes'], dependencies: ['build'] },
      ],
    })
    if (!created.ok) throw new Error(created.error)
    const started = planning.execute(created.plan.id, created.plan.revision)
    if (!started.ok) throw new Error(started.error)

    const delegateAgents = vi.fn().mockResolvedValue(evaluatorResult({
      criteria: [{ criterion: 'unrelated check', status: 'passed', evidence: ['proof'], reason: '' }],
    }))

    const result = await submitStageResultTool.execute({
      planId: 'plan-1',
      revision: started.plan.revision,
      stageId: 'build',
      summary: 'Implemented',
      evidence: ['proof'],
    }, baseContext({
      delegateAgents,
      submitStageResult: (input) => evaluation.submitStageResult(input),
      evaluateStage: (input) => evaluation.evaluateStage(input),
      evaluatePlan: (input) => evaluation.evaluatePlan(input),
      abortStageEvaluation: (planId, revision, stageId, reason) => evaluation.abortStageEvaluation(planId, revision, stageId, reason),
    }))

    expect(delegateAgents).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      ok: false,
      error: 'automatic evaluation failed: evaluator returned unknown or duplicate criterion',
    })
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
