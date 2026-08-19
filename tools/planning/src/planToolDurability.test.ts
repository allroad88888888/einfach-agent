import { describe, expect, it, vi } from 'vitest'
import type { PlanMutationResult, PlanSnapshot } from '@einfach-agent/core/planning'
import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import { createPlanTool } from './create-plan/create-plan'
import { executePlanTool } from './execute-plan/execute-plan'
import { submitStageResultTool } from './submit-stage-result/submit-stage-result'
import { updatePlanTool } from './update-plan/update-plan'

const plan: PlanSnapshot = {
  schemaVersion: 4,
  id: 'plan-1',
  title: 'Durable plan',
  objective: 'Wait for recovery persistence',
  status: 'active',
  revision: 1,
  requiresApproval: false,
  createdAt: 1,
  updatedAt: 1,
  stages: [],
}

function context(overrides: Partial<ToolContext>): ToolContext {
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

async function expectToolWaits(
  tool: Tool,
  input: unknown,
  overrides: Partial<ToolContext>,
): Promise<void> {
  let resolve: (result: PlanMutationResult) => void = () => undefined
  const durableResult = new Promise<PlanMutationResult>((next) => { resolve = next })
  const deferredContext = Object.fromEntries(
    Object.entries(overrides).map(([key]) => [key, vi.fn(() => durableResult)]),
  ) as Partial<ToolContext>
  const pending = tool.execute(input, context(deferredContext))
  let settled = false
  void Promise.resolve(pending).then(() => { settled = true })

  await Promise.resolve()
  expect(settled).toBe(false)
  resolve({ ok: true, plan })
  await expect(pending).resolves.toMatchObject({ ok: true, data: { id: 'plan-1' } })
}

describe('planning tool durable mutation boundary', () => {
  it('create_plan waits for its plan runtime write', async () => {
    await expectToolWaits(createPlanTool, {
      title: 'Durable plan', objective: 'Wait for recovery persistence', stages: [],
    }, { createPlan: async () => ({ ok: true, plan }) })
  })

  it('execute_plan waits for its plan runtime write', async () => {
    await expectToolWaits(executePlanTool, { planId: 'plan-1', revision: 1 }, {
      executePlan: async () => ({ ok: true, plan }),
    })
  })

  it('update_plan waits for its plan runtime write', async () => {
    await expectToolWaits(updatePlanTool, {
      planId: 'plan-1', revision: 1, stageId: 'stage-1', status: 'blocked', blockReason: 'waiting',
    }, { updatePlan: async () => ({ ok: true, plan }) })
  })

  it('submit_stage_result waits for its plan runtime write', async () => {
    await expectToolWaits(submitStageResultTool, {
      planId: 'plan-1', revision: 1, stageId: 'stage-1', summary: 'done', evidence: ['proof'],
    }, { submitStageResult: async () => ({ ok: true, plan }) })
  })

  it('does not report tool success when the durable plan write rejects', async () => {
    const result = await createPlanTool.execute({
      title: 'Durable plan', objective: 'Wait for recovery persistence', stages: [],
    }, context({ createPlan: async () => { throw new Error('recovery rejected') } }))

    expect(result).toMatchObject({ ok: false, code: 'PLAN_INVALID_INPUT' })
    expect('data' in result).toBe(false)
  })
})
