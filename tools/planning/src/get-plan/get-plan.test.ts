import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { PlanSnapshot } from '@einfach-agent/core/planning'
import { getPlanTool } from './get-plan'

function makeContext(getPlan?: ToolContext['getPlan']): ToolContext {
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...(getPlan ? { getPlan } : {}),
  } as ToolContext
}

const plan: PlanSnapshot = {
  schemaVersion: 4,
  id: 'plan-1',
  title: 'Plan',
  objective: 'Ship it',
  status: 'active',
  revision: 4,
  requiresApproval: false,
  createdAt: 1,
  updatedAt: 2,
  stages: [],
}

describe('get_plan', () => {
  it('returns the latest plan snapshot', async () => {
    expect(await getPlanTool.execute({}, makeContext(() => plan))).toEqual({
      ok: true,
      data: plan,
    })
  })

  it('reports missing plan state explicitly', async () => {
    expect(await getPlanTool.execute({}, makeContext(() => undefined))).toMatchObject({
      ok: false,
      code: 'PLAN_NOT_FOUND',
      retryable: false,
    })
  })

  it('reports an unavailable host capability', async () => {
    expect(await getPlanTool.execute({}, makeContext())).toMatchObject({
      ok: false,
      code: 'PLAN_UNAVAILABLE',
      retryable: false,
    })
  })

  it('returns a retryable failure when plan storage throws', async () => {
    expect(await getPlanTool.execute({}, makeContext(() => {
      throw new Error('storage unavailable')
    }))).toMatchObject({
      ok: false,
      error: 'get_plan failed: storage unavailable',
      code: 'PLAN_READ_FAILED',
      retryable: true,
    })
  })
})
