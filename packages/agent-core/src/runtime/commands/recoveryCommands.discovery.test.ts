import { describe, expect, it } from 'vitest'
import type { PlanSnapshot } from '../../planning/types'
import { activeSessionIdAtom } from '../../state/rootStore'
import { subagentContinuationsAtom } from '../../state/subagentContinuationAtoms'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { setPlan } from '../../state/planWriters'
import { createCore } from '../core/createCore'

function resumablePlan(status: 'approved' | 'active' = 'active'): PlanSnapshot {
  return {
    id: 'plan-1', title: 'Resume', objective: 'Continue recovered work', status, revision: 1,
    requiresApproval: false, createdAt: 1, updatedAt: 1,
    stages: [{
      id: 'stage-1', title: 'Implement', objective: 'Finish work', deliverables: [],
      dependencies: [], status: 'in_progress', evidence: [],
    }],
  }
}

function interruptedToolCall(core: ReturnType<typeof createCore>, id: string, outcome?: 'notStarted' | 'outcomeKnown' | 'outcomeUnknown') {
  const store = core.getSessionStore(id).store
  store.setter(itemsAtom, [
    { id: 'user-1', createdAt: 1, item: { role: 'user' as const, content: 'resume' } },
    {
      id: 'assistant-1', createdAt: 2,
      item: {
        role: 'assistant' as const, content: null,
        tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'shell_macos', arguments: '{}' } }],
      },
    },
  ])
  store.setter(runAtom, {
    runId: 'run-1', status: 'interrupted', turnId: 'user-1',
    ...(outcome ? { toolCallOutcomes: { 'call-1': { state: outcome, updatedAt: 3 } } } : {}),
  })
}

describe('session recovery discovery', () => {
  it('projects every session from its atoms without changing the selected session', () => {
    const core = createCore()
    const interrupted = core.newSession()
    const plan = core.newSession()
    const waiting = core.newSession()
    core.getSessionStore(interrupted).store.setter(runAtom, { runId: 'run-1', status: 'interrupted' })
    setPlan(plan, resumablePlan('approved'), core)
    core.getSessionStore(waiting).store.setter(runAtom, { runId: 'run-3', status: 'waiting_confirmation' })
    core.rootStore.setter(activeSessionIdAtom, waiting)

    const statuses = new Map(core.listSessionRecoveryStatuses().map((status) => [status.sessionId, status]))

    expect(statuses.get(interrupted)).toMatchObject({ status: 'recoverable', continuation: 'interrupted_run' })
    expect(statuses.get(plan)).toEqual({ status: 'recoverable', sessionId: plan, continuation: 'plan', planStatus: 'approved' })
    expect(statuses.get(waiting)).toEqual({ status: 'awaiting_user', sessionId: waiting, waitingFor: 'waiting_confirmation' })
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(waiting)
  })

  it.each([
    'queued', 'interrupted', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'outcome_unknown',
  ] as const)('requires reconciliation for a restored %s subagent continuation', (state) => {
    const core = createCore()
    const id = core.newSession()
    core.getSessionStore(id).store.setter(subagentContinuationsAtom, [{
      schemaVersion: 1, childId: 'child-1', parentRunId: 'parent-1', parentNodeId: null, state, spec: { objective: 'child' },
    }])

    expect(core.getSessionRecoveryStatus(id)).toEqual({
      status: 'reconciliation_required', sessionId: id, reason: 'subagent_continuation',
    })
  })

  it.each([
    ['missing', undefined],
    ['known without a receipt', 'outcomeKnown'],
    ['unknown', 'outcomeUnknown'],
  ] as const)('requires reconciliation for a %s interrupted tool outcome', (_label, outcome) => {
    const core = createCore()
    const id = core.newSession()
    interruptedToolCall(core, id, outcome)

    expect(core.getSessionRecoveryStatus(id)).toEqual({
      status: 'reconciliation_required', sessionId: id, reason: 'tool_outcome',
    })
  })

  it('keeps a provably unstarted tool call recoverable for the existing receipt boundary', () => {
    const core = createCore()
    const id = core.newSession()
    interruptedToolCall(core, id, 'notStarted')

    expect(core.getSessionRecoveryStatus(id)).toEqual({
      status: 'recoverable', sessionId: id, continuation: 'interrupted_run', runId: 'run-1',
    })
  })

  it('reports missing, live, and awaiting-plan sessions without dispatching work', () => {
    const core = createCore()
    const idle = core.newSession()
    const livePlan = core.newSession()
    const approval = core.newSession()
    setPlan(livePlan, resumablePlan(), core)
    core.getSessionStore(livePlan).store.setter(runAtom, { runId: 'live', status: 'running' })
    setPlan(approval, { ...resumablePlan(), status: 'awaiting_approval', requiresApproval: true }, core)

    expect(core.getSessionRecoveryStatus('gone')).toEqual({
      status: 'unavailable', sessionId: 'gone', reason: 'session_missing',
    })
    expect(core.getSessionRecoveryStatus(idle)).toEqual({
      status: 'unavailable', sessionId: idle, reason: 'nonrecoverable',
    })
    expect(core.getSessionRecoveryStatus(livePlan)).toEqual({
      status: 'unavailable', sessionId: livePlan, reason: 'nonrecoverable',
    })
    expect(core.getSessionRecoveryStatus(approval)).toEqual({
      status: 'awaiting_user', sessionId: approval, waitingFor: 'plan_approval',
    })
  })
})
