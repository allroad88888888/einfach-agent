import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))

import { activeSessionIdAtom } from '../../state/rootStore'
import { subagentContinuationsAtom } from '../../state/subagentContinuationAtoms'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { setPlan } from '../../state/planWriters'
import { resumeInterruptedSession, resumePlanSession, runToolLoop } from '../modelRun'
import { createCore } from '../core/createCore'

afterEach(() => {
  vi.clearAllMocks()
})

function setInterruptedRun(core: ReturnType<typeof createCore>, id: string): void {
  core.getSessionStore(id).store.setter(runAtom, { runId: 'interrupted-run', status: 'interrupted' })
}

function setInterruptedTool(core: ReturnType<typeof createCore>, id: string): void {
  const store = core.getSessionStore(id).store
  store.setter(itemsAtom, [
    { id: 'user-1', createdAt: 1, item: { role: 'user' as const, content: 'resume' } },
    {
      id: 'assistant-1', createdAt: 2,
      item: {
        role: 'assistant' as const, content: null,
        tool_calls: [{ id: 'tool-1', type: 'function' as const, function: { name: 'shell_macos', arguments: '{}' } }],
      },
    },
  ])
  store.setter(runAtom, { runId: 'interrupted-run', status: 'interrupted', turnId: 'user-1' })
}

function setInterruptedTimedOutcome(
  core: ReturnType<typeof createCore>,
  id: string,
  state: 'outcomeKnown' | 'outcomeUnknown',
): void {
  core.getSessionStore(id).store.setter(runAtom, {
    runId: 'interrupted-run', status: 'interrupted',
    toolCallOutcomes: {
      'timed:turnEnd:interrupted-run:timer': { state, updatedAt: 3 },
    },
  })
}

describe('continueRecoveredSession', () => {
  it('continues the requested interrupted session without selecting it', async () => {
    const core = createCore()
    const recovered = core.newSession()
    const selected = core.newSession()
    setInterruptedRun(core, recovered)
    core.rootStore.setter(activeSessionIdAtom, selected)

    expect(core.continueRecoveredSession(recovered)).toEqual({
      status: 'continued', sessionId: recovered, continuation: 'interrupted_run',
    })
    expect(resumeInterruptedSession).toHaveBeenCalledOnce()
    expect(vi.mocked(resumeInterruptedSession).mock.calls[0]?.[0]).toBe(recovered)
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(selected)
    expect(resumePlanSession).not.toHaveBeenCalled()
    expect(runToolLoop).not.toHaveBeenCalled()
    await Promise.resolve()
  })

  it('uses the persisted plan continuation boundary for an unselected session', async () => {
    const core = createCore()
    const recovered = core.newSession()
    const selected = core.newSession()
    setPlan(recovered, {
      id: 'plan-1', title: 'Resume', objective: 'Finish recovered plan', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 1,
      stages: [{
        id: 'stage-1', title: 'Implement', objective: 'Finish', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    }, core)
    core.rootStore.setter(activeSessionIdAtom, selected)

    expect(core.continueRecoveredSession(recovered)).toEqual({
      status: 'continued', sessionId: recovered, continuation: 'plan',
    })
    expect(resumePlanSession).toHaveBeenCalledOnce()
    expect(vi.mocked(resumePlanSession).mock.calls[0]?.[0]).toBe(recovered)
    expect(core.rootStore.getter(activeSessionIdAtom)).toBe(selected)
    expect(resumeInterruptedSession).not.toHaveBeenCalled()
    await Promise.resolve()
  })

  it('does not dispatch waiting, subagent, or uncertain-tool recoveries', () => {
    const core = createCore()
    const waiting = core.newSession()
    const child = core.newSession()
    const tool = core.newSession()
    core.getSessionStore(waiting).store.setter(runAtom, { runId: 'waiting-run', status: 'waiting_user' })
    core.getSessionStore(child).store.setter(subagentContinuationsAtom, [{
      schemaVersion: 1, childId: 'child-1', parentRunId: 'parent-1', parentNodeId: null,
      state: 'outcome_unknown', spec: { objective: 'reconcile' },
    }])
    setInterruptedTool(core, tool)

    expect(core.continueRecoveredSession(waiting)).toEqual({
      status: 'awaiting_user', sessionId: waiting, waitingFor: 'waiting_user',
    })
    expect(core.continueRecoveredSession(child)).toEqual({
      status: 'reconciliation_required', sessionId: child, reason: 'subagent_continuation',
    })
    expect(core.continueRecoveredSession(tool)).toEqual({
      status: 'reconciliation_required', sessionId: tool, reason: 'tool_outcome',
    })
    expect(resumeInterruptedSession).not.toHaveBeenCalled()
    expect(resumePlanSession).not.toHaveBeenCalled()
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown timed outcome', 'outcomeUnknown'],
    ['known timed outcome without its receipt', 'outcomeKnown'],
  ] as const)('does not dispatch a %s before the timed recovery fence', (_label, state) => {
    const core = createCore()
    const id = core.newSession()
    setInterruptedTimedOutcome(core, id, state)

    expect(core.continueRecoveredSession(id)).toEqual({
      status: 'reconciliation_required', sessionId: id, reason: 'tool_outcome',
    })
    expect(resumeInterruptedSession).not.toHaveBeenCalled()
    expect(resumePlanSession).not.toHaveBeenCalled()
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('does not dispatch when a normal receipt contradicts its not-started fact', () => {
    const core = createCore()
    const id = core.newSession()
    setInterruptedTool(core, id)
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [...store.getter(itemsAtom), {
      id: 'tool-receipt', createdAt: 3,
      item: { role: 'tool' as const, tool_call_id: 'tool-1', content: '{}' },
    }])
    store.setter(runAtom, {
      runId: 'interrupted-run', status: 'interrupted', turnId: 'user-1',
      toolCallOutcomes: { 'tool-1': { state: 'notStarted', updatedAt: 3 } },
    })

    expect(core.continueRecoveredSession(id)).toEqual({
      status: 'reconciliation_required', sessionId: id, reason: 'tool_outcome',
    })
    expect(resumeInterruptedSession).not.toHaveBeenCalled()
  })

  it('continues a known session-start timed receipt recorded before the turn anchor', () => {
    const core = createCore()
    const id = core.newSession()
    const store = core.getSessionStore(id).store
    const callId = 'timed:sessionStart:session_brief'
    store.setter(itemsAtom, [
      { id: 'session-start-receipt', createdAt: 1, item: { role: 'tool' as const, tool_call_id: callId, content: '{}' } },
      { id: 'user-1', createdAt: 2, item: { role: 'user' as const, content: 'resume' } },
    ])
    store.setter(runAtom, {
      runId: 'interrupted-run', status: 'interrupted', turnId: 'user-1',
      toolCallOutcomes: { [callId]: { state: 'outcomeKnown', updatedAt: 2 } },
    })

    expect(core.getSessionRecoveryStatus(id)).toEqual({
      status: 'recoverable', sessionId: id, continuation: 'interrupted_run', runId: 'interrupted-run',
    })
    expect(core.continueRecoveredSession(id)).toEqual({
      status: 'continued', sessionId: id, continuation: 'interrupted_run',
    })
    expect(resumeInterruptedSession).toHaveBeenCalledWith(id, expect.any(Object))
  })
})
