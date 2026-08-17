// v1 恢复编排：checkpoint 只保留 undo/history，绝不拼接成运行态。

import { beforeEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import { executionGraphAtom, EMPTY_EXECUTION_GRAPH } from '../../execution/graph'
import { rootStore, resetRootStore, sessionsAtom } from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import {
  checkpointsAtom,
  contextCheckpointAtom,
  currentTurnIndexAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from '../sessionAtoms'
import { subagentContinuationsAtom } from '../subagentContinuationAtoms'
import { pendingQuestionAnswersAtom, queuedUserMessagesAtom } from '../transientAtoms'
import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
import { applyRecoverySnapshot } from '../recoveryProjection'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import type { RecoveryDriver } from './recoveryDriver'
import { hydrate } from './hydrate'
import { normalizeRecoverySnapshotForHydration } from './recoveryHydration'

type RecoveryRunStatus = NonNullable<RecoverySnapshotV1['values']['run']>['status']

function session(id = 's1', title = 'Session'): SessionMeta {
  return {
    id,
    title,
    settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    createdAt: 1,
    updatedAt: 2,
  }
}

function plan(id: string) {
  return {
    schemaVersion: 4 as const,
    id,
    title: id,
    objective: 'resume exactly',
    status: 'active' as const,
    revision: 1,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: 2,
    stages: [{
      id: 'stage-1', title: 'stage', objective: 'work', deliverables: [], dependencies: [],
      status: 'in_progress' as const, evidence: [],
    }],
  }
}

function graph(sessionId: string, id: string, status: 'interrupted' | 'running' = 'interrupted') {
  return {
    version: 1 as const,
    nodes: {
      [id]: {
        id, graphId: 'graph-1', sessionId, runId: 'run-1', dependsOn: [], type: 'agent' as const,
        status, label: 'child', attempt: 1, generation: 1, effectKeys: [], createdAt: 1, updatedAt: 2,
      },
    },
    order: [id],
  }
}

function snapshot(id = 's1', status: RecoveryRunStatus = 'running'): RecoverySnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: id,
    capturedAt: 9,
    generation: 2,
    commitMarker: 'complete',
    session: session(id, `Snapshot ${id}`),
    values: {
      conversation: {
        items: [{ id: 'snapshot-item', createdAt: 3, item: { role: 'user', content: 'v1 truth' } }],
        contextCheckpoint: {
          schemaVersion: 1, summary: 'durable context', coveredItemIds: ['snapshot-item'],
          createdAt: 3, sourceEstimatedTokens: 4,
        },
      },
      plan: {
        current: plan('snapshot-plan'),
        stageCheckpoints: [{ stageId: 'stage-1', plan: plan('before-stage'), itemCount: 0, createdAt: 2 }],
      },
      run: { runId: 'snapshot-run', status, pendingQuestion: { question: 'continue?' } },
      queuedUserMessages: [{ id: 'queue-1', createdAt: 4, content: 'queued v1', targetRunId: 'snapshot-run' }],
      pendingQuestionAnswers: { ask: ['yes', 'later'] },
      pendingArtifacts: [{ id: 'artifact-1', filename: 'pending.md', content: 'only copy' }],
      composerDraft: 'restored draft',
      executionGraph: graph(id, 'snapshot-node'),
      subagentContinuations: [{
        schemaVersion: 1, childId: 'child-1', parentRunId: 'snapshot-run', parentNodeId: 'snapshot-node',
        state: 'waiting_user', spec: { task: 'resume only from v1' },
      }],
    },
  }
}

function checkpoint(content: string): Checkpoint {
  return {
    turnIndex: 0,
    label: 'checkpoint',
    createdAt: 3,
    items: [{ id: 'checkpoint-item', createdAt: 3, item: { role: 'user', content } }],
  }
}

function recoveryDriver(rows: Record<string, unknown> = {}, listed: unknown[] = []): RecoveryDriver {
  return {
    async listLatest() { return listed as RecoverySnapshotV1[] },
    async loadLatest(id) {
      const value = rows[id]
      if (value instanceof Error) throw value
      return value as RecoverySnapshotV1 | undefined
    },
    async saveLatest(_id, value) { return { status: 'saved' as const, generation: value.generation } },
    async deleteSession() {},
  }
}

beforeEach(() => {
  resetRootStore()
  resetSessionStores()
})

describe('hydrate · v1 recovery priority', () => {
  it('keeps v1 live atoms authoritative while retaining sanitized checkpoint history', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('s1', checkpoint('checkpoint history'))
    const record = snapshot()

    await expect(hydrate({
      sessions: { loadSessions: async () => [session()] }, history,
      recovery: recoveryDriver({ s1: record }),
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(checkpointsAtom)).toEqual([checkpoint('checkpoint history')])
    expect(store.getter(itemsAtom)).toEqual(record.values.conversation.items)
    expect(store.getter(planAtom)).toEqual(record.values.plan.current)
    expect(store.getter(executionGraphAtom)).toEqual(record.values.executionGraph)
    expect(store.getter(runAtom)).toEqual({ ...record.values.run, status: 'interrupted' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual(record.values.queuedUserMessages)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual(record.values.pendingQuestionAnswers)
    expect(rootStore.getter(sessionsAtom).s1).toMatchObject(record.session)
  })

  it('keeps corrupt v1 static-only while retaining sanitized checkpoint history', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('s1', checkpoint('checkpoint history'))
    // hydrateForCore also serves a reused Core. Seed every v1-owned field and
    // stale history to prove an invalid v1 cannot leave either projection live.
    const staleStore = getSessionStore('s1').store
    applyRecoverySnapshot(staleStore, snapshot('s1', 'interrupted'))
    staleStore.setter(checkpointsAtom, [checkpoint('stale in-memory history')])
    staleStore.setter(currentTurnIndexAtom, 9)

    await expect(hydrate({
      sessions: { loadSessions: async () => [session()] }, history,
      recovery: recoveryDriver({ s1: { schemaVersion: 1, sessionId: 's1' } }),
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(checkpointsAtom)).toEqual([checkpoint('checkpoint history')])
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(store.getter(planAtom)).toBeUndefined()
    expect(store.getter(planStageCheckpointsAtom)).toEqual([])
    expect(store.getter(executionGraphAtom)).toEqual(EMPTY_EXECUTION_GRAPH)
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual({})
    expect(store.getter(subagentContinuationsAtom)).toEqual([])
    expect(store.getter(currentTurnIndexAtom)).toBe(0)
  })

  it('keeps absent-v1 checkpoint history out of live recovery', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('s1', checkpoint('checkpoint history'))

    await expect(hydrate({
      sessions: { loadSessions: async () => [session()] }, history, recovery: recoveryDriver(),
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(checkpointsAtom)).toEqual([checkpoint('checkpoint history')])
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(executionGraphAtom)).toEqual(EMPTY_EXECUTION_GRAPH)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual({})
    expect(store.getter(subagentContinuationsAtom)).toEqual([])
    expect(store.getter(currentTurnIndexAtom)).toBe(0)
  })

  it('clears stale checkpoint history and cursor when a reused Core has no saved checkpoints', async () => {
    const store = getSessionStore('s1').store
    store.setter(checkpointsAtom, [checkpoint('stale in-memory history')])
    store.setter(currentTurnIndexAtom, 7)

    await expect(hydrate({
      sessions: { loadSessions: async () => [session()] },
      history: createMemoryHistoryDriver(), recovery: recoveryDriver(),
    })).resolves.toBe(true)

    expect(store.getter(checkpointsAtom)).toEqual([])
    expect(store.getter(currentTurnIndexAtom)).toBe(-1)
  })

  it('interrupts all process-live v1 run and graph states', () => {
    const normalized = normalizeRecoverySnapshotForHydration(snapshot('s1', 'running'))

    expect(normalized.values.run).toMatchObject({ status: 'interrupted', pendingQuestion: { question: 'continue?' } })
    expect(normalized.values.run).not.toHaveProperty('pendingExecutionId')
    expect(normalized.values.executionGraph.nodes['snapshot-node']?.status).toBe('interrupted')

    const activeGraph = snapshot('s1', 'waiting_user')
    activeGraph.values.executionGraph = graph('s1', 'snapshot-node', 'running')
    expect(normalizeRecoverySnapshotForHydration(activeGraph).values.executionGraph.nodes['snapshot-node']?.status)
      .toBe('interrupted')
  })

  it('reconstructs a root session from v1 when the session list is unreadable', async () => {
    const history = createMemoryHistoryDriver()
    const record = snapshot('orphan', 'waiting_confirmation')

    await expect(hydrate({
      sessions: { loadSessions: async () => { throw new Error('session list unavailable') } }, history,
      recovery: recoveryDriver({}, [record]),
    })).resolves.toBe(true)

    const store = getSessionStore('orphan').store
    expect(rootStore.getter(sessionsAtom).orphan).toMatchObject(record.session)
    expect(store.getter(itemsAtom)).toEqual(record.values.conversation.items)
    expect(store.getter(planAtom)).toEqual(record.values.plan.current)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual(record.values.pendingQuestionAnswers)
    expect(store.getter(runAtom)).toEqual(record.values.run)
  })
})
