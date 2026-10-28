import { expect, it } from 'vitest'
import { createCoreInstance } from './core/coreInstance'
import { pendingDecisionOrigin } from './toolLoopPlan'
import { planAtom, runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import { captureRecoverySnapshot, applyRecoverySnapshot } from '../state/recoveryProjection'
import { plan, recoverySession, sessionId } from '../state/recoveryProjection.fixtures'
import type { PlanStatus } from '../planning/types'

it.each<PlanStatus>(['draft', 'awaiting_approval', 'approved', 'active', 'completed', 'failed', 'cancelled'])(
  'persists and restores a question without a stage when the existing plan is %s',
  (status) => {
    const core = createCoreInstance()
    core.rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
    const store = core.getSessionStore(sessionId).store
    store.setter(planAtom, { ...plan(), status })
    const payload = {
      context: { surface: 'conversation' },
      questions: [{ id: 'ready', text: '准备好了吗？', type: 'confirm' }],
    }
    const origin = pendingDecisionOrigin(sessionId, payload, undefined, core)
    const terminal = ['completed', 'failed', 'cancelled'].includes(status)
    expect(origin.surface).toBe(terminal ? 'conversation' : 'plan')
    expect(origin).not.toHaveProperty('stageId')
    store.setter(runAtom, {
      runId: 'question-run', status: 'waiting_user', pendingQuestion: payload,
      pendingUserDecision: { callId: 'question-call', payload, origin },
    })
    const snapshot = captureRecoverySnapshot(store, { rootStore: core.rootStore, sessionId, generation: 1 })
    store.setter(runAtom, undefined)
    applyRecoverySnapshot(store, snapshot)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'waiting_user', pendingQuestion: payload,
      pendingUserDecision: { callId: 'question-call', payload, origin },
    })
  },
)

it('retains the current stage on an executing plan decision', () => {
  const core = createCoreInstance()
  core.rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
  core.getSessionStore(sessionId).store.setter(planAtom, plan())
  expect(pendingDecisionOrigin(sessionId, {}, 'stage-1', core)).toEqual({
    surface: 'plan', phase: 'executing', planId: 'plan-1', planRevision: 2, stageId: 'stage-1',
  })
})

it('honors a new plan drafting question after the old plan completed', () => {
  const core = createCoreInstance()
  core.rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
  core.getSessionStore(sessionId).store.setter(planAtom, { ...plan(), status: 'completed' })
  expect(pendingDecisionOrigin(sessionId, { context: { surface: 'plan', phase: 'drafting' } }, undefined, core))
    .toEqual({ surface: 'plan', phase: 'drafting' })
})
