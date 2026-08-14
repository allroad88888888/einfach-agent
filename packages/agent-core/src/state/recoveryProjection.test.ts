import { createStore, type Store } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { executionGraphAtom, executionEventsAtom } from '../execution/graph'
import type { ExecutionGraphSnapshot } from '../execution/types'
import { sessionsAtom } from './rootAtoms'
import { applyRecoverySnapshot, captureRecoverySnapshot } from './recoveryProjection'
import type { RecoverySnapshotV1 } from './recoverySnapshot.type'
import {
  checkpointsAtom,
  contextCheckpointAtom,
  currentTurnIndexAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from './sessionAtoms'
import {
  assistantStreamAtom,
  alwaysAllowedToolsAtom,
  browserCardsAtom,
  composerDraftAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
  toolActivityAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'

const sessionId = 'session-recovery'
const recoverySession = {
  id: sessionId,
  title: 'Recovery session',
  settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
  createdAt: 1,
  updatedAt: 2,
}

function plan(id = 'plan-1') {
  return {
    schemaVersion: 4 as const,
    id,
    title: 'Recover work',
    objective: 'Resume exactly',
    status: 'active' as const,
    revision: 2,
    requiresApproval: false,
    createdAt: 10,
    updatedAt: 11,
    stages: [{
      id: 'stage-1',
      title: 'Implement',
      objective: 'write code',
      deliverables: ['code'],
      dependencies: [],
      status: 'in_progress' as const,
      evidence: [],
    }],
  }
}

function graph(id = 'node-1'): ExecutionGraphSnapshot {
  return {
    version: 1,
    nodes: {
      [id]: {
        id,
        graphId: 'graph-1',
        sessionId,
        runId: 'run-1',
        dependsOn: [],
        type: 'agent',
        status: 'interrupted',
        label: 'child work',
        attempt: 1,
        generation: 1,
        effectKeys: ['child:one'],
        createdAt: 20,
        updatedAt: 21,
      },
    },
    order: [id],
  }
}

function seedDurableState(store: Store): void {
  const currentPlan = plan()
  store.setter(itemsAtom, [{
    id: 'item-1',
    createdAt: 1,
    item: { role: 'user', content: 'continue my task' },
  }])
  store.setter(contextCheckpointAtom, {
    schemaVersion: 1,
    summary: 'Earlier work',
    coveredItemIds: ['item-1'],
    createdAt: 2,
    sourceEstimatedTokens: 3,
  })
  store.setter(planAtom, currentPlan)
  store.setter(planStageCheckpointsAtom, [{
    stageId: 'stage-1',
    plan: currentPlan,
    itemCount: 1,
    createdAt: 12,
  }])
  store.setter(runAtom, {
    runId: 'run-1',
    status: 'waiting_user',
    startedAt: 4,
    turnId: 'item-1',
    pendingExecutionId: 'process-only-handle',
    pendingQuestion: { questionId: 'ask-1' },
    pendingUserDecision: {
      callId: 'call-1',
      payload: { questionId: 'ask-1' },
      origin: { surface: 'conversation', phase: 'executing' },
    },
  })
  store.setter(queuedUserMessagesAtom, [{
    id: 'queued-1',
    createdAt: 5,
    content: 'Queued while waiting',
    targetRunId: 'run-1',
    submissionSequence: 4,
  }])
  store.setter(pendingQuestionAnswersAtom, { 'ask-1': ['first', 'second'] })
  store.setter(executionGraphAtom, graph())
  store.setter(subagentContinuationsAtom, [{
    schemaVersion: 1,
    childId: 'child-1',
    parentRunId: 'run-1',
    parentNodeId: 'node-1',
    state: 'waiting_user',
    spec: { task: 'audit the implementation' },
  }])
}

function capture(store: Store): RecoverySnapshotV1 {
  const rootStore = createStore()
  rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
  return captureRecoverySnapshot(store, { rootStore, sessionId, generation: 7, capturedAt: 99 })
}

describe('recoveryProjection', () => {
  it('round-trips every allowlisted durable value and excludes pendingExecutionId', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)

    const snapshot = capture(source)
    applyRecoverySnapshot(target, snapshot)

    expect(snapshot.session).toEqual(recoverySession)
    expect(snapshot.values.run).not.toHaveProperty('pendingExecutionId')
    expect(target.getter(itemsAtom)).toEqual(snapshot.values.conversation.items)
    expect(target.getter(contextCheckpointAtom)).toEqual(snapshot.values.conversation.contextCheckpoint)
    expect(target.getter(planAtom)).toEqual(snapshot.values.plan.current)
    expect(target.getter(planStageCheckpointsAtom)).toEqual(snapshot.values.plan.stageCheckpoints)
    expect(target.getter(runAtom)).toEqual(snapshot.values.run)
    expect(target.getter(queuedUserMessagesAtom)).toEqual(snapshot.values.queuedUserMessages)
    expect(target.getter(pendingQuestionAnswersAtom)).toEqual({ 'ask-1': ['first', 'second'] })
    expect(target.getter(executionGraphAtom)).toEqual(snapshot.values.executionGraph)
    expect(target.getter(subagentContinuationsAtom)).toEqual(snapshot.values.subagentContinuations)
  })

  it('uses null for absent durable atom values and restores them as undefined', () => {
    const source = createStore()
    const target = createStore()
    const snapshot = capture(source)

    expect(snapshot.values.conversation.contextCheckpoint).toBeNull()
    expect(snapshot.values.plan.current).toBeNull()
    expect(snapshot.values.run).toBeNull()

    seedDurableState(target)
    applyRecoverySnapshot(target, snapshot)
    expect(target.getter(contextCheckpointAtom)).toBeUndefined()
    expect(target.getter(planAtom)).toBeUndefined()
    expect(target.getter(runAtom)).toBeUndefined()
  })

  it('JSON-clones a captured projection before a writer can observe later source changes', () => {
    const store = createStore()
    seedDurableState(store)
    const snapshot = capture(store)

    expect(snapshot.values.conversation.items).not.toBe(store.getter(itemsAtom))
    expect(snapshot.values.pendingQuestionAnswers).not.toBe(store.getter(pendingQuestionAnswersAtom))
    expect(snapshot.values.executionGraph).not.toBe(store.getter(executionGraphAtom))
    expect(snapshot.values.subagentContinuations).not.toBe(store.getter(subagentContinuationsAtom))

    store.setter(itemsAtom, [])
    store.setter(pendingQuestionAnswersAtom, {})
    expect(snapshot.values.conversation.items).toHaveLength(1)
    expect(snapshot.values.pendingQuestionAnswers).toEqual({ 'ask-1': ['first', 'second'] })
  })

  it('rejects function and cycle values before capture or atomic apply can alter state', () => {
    const malformed = createStore()
    malformed.setter(runAtom, { runId: 'bad', status: 'waiting_user', pendingQuestion: () => undefined })
    expect(() => capture(malformed)).toThrow('Recovery projection does not satisfy')
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    malformed.setter(runAtom, { runId: 'bad', status: 'waiting_user', pendingQuestion: cycle })
    expect(() => capture(malformed)).toThrow('Recovery projection does not satisfy')

    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    target.setter(itemsAtom, [{ id: 'preserve', createdAt: 1, item: { role: 'user', content: 'unchanged' } }])
    const functionSnapshot = capture(source)
    functionSnapshot.values.run!.pendingQuestion = () => undefined
    const cycleSnapshot = capture(source)
    cycleSnapshot.values.run!.pendingQuestion = cycle

    expect(() => applyRecoverySnapshot(target, functionSnapshot)).toThrow('Cannot apply an invalid')
    expect(() => applyRecoverySnapshot(target, cycleSnapshot)).toThrow('Cannot apply an invalid')
    expect(target.getter(itemsAtom)).toEqual([{ id: 'preserve', createdAt: 1, item: { role: 'user', content: 'unchanged' } }])
  })

  it('publishes recovery as one coherent Einfach update', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    const snapshot = capture(source)
    const observed: Array<{ planId: string | undefined; runId: string | undefined; answer: unknown }> = []
    const unsubscribe = target.sub(itemsAtom, () => {
      observed.push({
        planId: target.getter(planAtom)?.id,
        runId: target.getter(runAtom)?.runId,
        answer: target.getter(pendingQuestionAnswersAtom)['ask-1'],
      })
    })

    applyRecoverySnapshot(target, snapshot)
    unsubscribe()

    expect(observed).toEqual([{ planId: 'plan-1', runId: 'run-1', answer: ['first', 'second'] }])
  })

  it('leaves derived, UI, history, and safety atoms outside the allowlist untouched', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    target.setter(checkpointsAtom, [{ turnIndex: 1, label: 'keep', createdAt: 1, items: [] }])
    target.setter(currentTurnIndexAtom, 1)
    target.setter(browserCardsAtom, [{ id: 'card-1', createdAt: 1, title: 'keep card' }])
    target.setter(assistantStreamAtom, {
      runId: 'ui-run',
      item: { id: 'stream-1', createdAt: 1, item: { role: 'assistant', content: 'keep stream' } },
    })
    target.setter(composerDraftAtom, 'unsent draft')
    target.setter(toolActivityAtom, [{ callId: 'tool-1', toolName: 'write_file', text: 'running' }])
    target.setter(alwaysAllowedToolsAtom, ['write_file'])
    target.setter(executionEventsAtom, [{ type: 'graph.hydrated', at: 1 }])

    applyRecoverySnapshot(target, capture(source))

    expect(target.getter(checkpointsAtom)).toHaveLength(1)
    expect(target.getter(currentTurnIndexAtom)).toBe(1)
    expect(target.getter(browserCardsAtom)).toHaveLength(1)
    expect(target.getter(assistantStreamAtom)?.runId).toBe('ui-run')
    expect(target.getter(composerDraftAtom)).toBe('unsent draft')
    expect(target.getter(toolActivityAtom)).toEqual([{ callId: 'tool-1', toolName: 'write_file', text: 'running' }])
    expect(target.getter(alwaysAllowedToolsAtom)).toEqual(['write_file'])
    expect(target.getter(executionEventsAtom)).toEqual([{ type: 'graph.hydrated', at: 1 }])
  })

  it('keeps recovery projection and its sole child continuation atom isolated per store', () => {
    const first = createStore()
    const second = createStore()
    seedDurableState(first)
    second.setter(subagentContinuationsAtom, [{
      schemaVersion: 1,
      childId: 'child-2',
      parentRunId: 'run-2',
      parentNodeId: null,
      state: 'queued',
      spec: { task: 'other session' },
    }])

    const snapshot = capture(first)
    applyRecoverySnapshot(first, snapshot)

    expect(second.getter(itemsAtom)).toEqual([])
    expect(second.getter(subagentContinuationsAtom)).toEqual([{
      schemaVersion: 1,
      childId: 'child-2',
      parentRunId: 'run-2',
      parentNodeId: null,
      state: 'queued',
      spec: { task: 'other session' },
    }])
    expect(snapshot).not.toHaveProperty('continuation')
    expect(snapshot.values.subagentContinuations).toEqual(first.getter(subagentContinuationsAtom))
  })
})
