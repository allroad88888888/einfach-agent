// v1 恢复优先编排：只能选择完整投影或 legacy，绝不拼接二者。

import { beforeEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import { executionGraphAtom, EMPTY_EXECUTION_GRAPH } from '../../execution/graph'
import { rootStore, resetRootStore, sessionsAtom } from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import {
  checkpointsAtom,
  itemsAtom,
  planAtom,
  runAtom,
} from '../sessionAtoms'
import { pendingQuestionAnswersAtom, queuedUserMessagesAtom } from '../transientAtoms'
import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import type { RecoveryDriver } from './recoveryDriver'
import { hydrate } from './hydrate'
import { normalizeRecoverySnapshotForHydration } from './recoveryHydration'

type RecoveryRunStatus = NonNullable<RecoverySnapshotV1['values']['run']>['status']

function session(id = 's1', title = 'Legacy'): SessionMeta {
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

function graph(sessionId: string, id: string) {
  return {
    version: 1 as const,
    nodes: {
      [id]: {
        id, graphId: 'graph-1', sessionId, runId: 'run-1', dependsOn: [], type: 'agent' as const,
        status: 'interrupted' as const, label: 'child', attempt: 1, generation: 1, effectKeys: [],
        createdAt: 1, updatedAt: 2,
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
        contextCheckpoint: null,
      },
      plan: { current: plan('snapshot-plan'), stageCheckpoints: [] },
      run: { runId: 'snapshot-run', status, pendingQuestion: { question: 'continue?' } },
      queuedUserMessages: [{ id: 'queue-1', createdAt: 4, content: 'queued v1', targetRunId: 'snapshot-run' }],
      pendingQuestionAnswers: { ask: ['yes', 'later'] },
      executionGraph: graph(id, 'snapshot-node'),
      subagentContinuations: [],
    },
  }
}

function checkpoint(content: string, recovery?: Checkpoint['recovery']): Checkpoint {
  return {
    turnIndex: 0,
    label: 'legacy checkpoint',
    createdAt: 3,
    items: [{ id: 'legacy-item', createdAt: 3, item: { role: 'user', content } }],
    recovery,
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
  it('uses the complete v1 projection instead of combining legacy dynamic data', async () => {
    const history = createMemoryHistoryDriver()
    const legacy = { ...session(), plan: plan('legacy-plan'), executionGraph: graph('s1', 'legacy-node') }
    await history.saveCheckpoint('s1', checkpoint('legacy truth', {
      run: { runId: 'legacy-run', status: 'waiting_user' },
      queuedUserMessages: [{ id: 'legacy-q', createdAt: 4, content: 'legacy queue', targetRunId: 'legacy-run' }],
    }))
    const record = snapshot()

    await expect(hydrate({
      sessions: { loadSessions: async () => [legacy] }, history,
      recovery: recoveryDriver({ s1: record }),
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(checkpointsAtom)).toEqual([])
    expect(store.getter(itemsAtom)).toEqual(record.values.conversation.items)
    expect(store.getter(planAtom)).toEqual(record.values.plan.current)
    expect(store.getter(executionGraphAtom)).toEqual(record.values.executionGraph)
    expect(store.getter(runAtom)).toEqual({ ...record.values.run, status: 'interrupted' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual(record.values.queuedUserMessages)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual(record.values.pendingQuestionAnswers)
    expect(rootStore.getter(sessionsAtom).s1).toMatchObject(record.session)
    expect(rootStore.getter(sessionsAtom).s1).not.toHaveProperty('plan')
    expect(rootStore.getter(sessionsAtom).s1).not.toHaveProperty('executionGraph')
  })

  it('blocks corrupt v1 without falling back to legacy dynamic state', async () => {
    const history = createMemoryHistoryDriver()
    const legacy = { ...session(), plan: plan('legacy-plan'), executionGraph: graph('s1', 'legacy-node') }
    await history.saveCheckpoint('s1', checkpoint('legacy truth', { run: { runId: 'legacy-run', status: 'waiting_user' } }))

    await expect(hydrate({
      sessions: { loadSessions: async () => [legacy] }, history,
      recovery: recoveryDriver({ s1: { schemaVersion: 1, sessionId: 's1' } }),
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(planAtom)).toBeUndefined()
    expect(store.getter(executionGraphAtom)).toEqual(EMPTY_EXECUTION_GRAPH)
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(checkpointsAtom)).toEqual([])
    expect(rootStore.getter(sessionsAtom).s1).not.toHaveProperty('plan')
    expect(rootStore.getter(sessionsAtom).s1).not.toHaveProperty('executionGraph')
  })

  it('uses legacy recovery only when v1 is absent', async () => {
    const history = createMemoryHistoryDriver()
    const legacy = { ...session(), plan: plan('legacy-plan'), executionGraph: graph('s1', 'legacy-node') }
    const recovery = { run: { runId: 'legacy-run', status: 'waiting_user' as const, pendingQuestion: { q: 'legacy?' } } }
    await history.saveCheckpoint('s1', checkpoint('legacy truth', recovery))

    await hydrate({ sessions: { loadSessions: async () => [legacy] }, history, recovery: recoveryDriver() })

    const store = getSessionStore('s1').store
    expect(store.getter(itemsAtom)).toEqual(checkpoint('legacy truth').items)
    expect(store.getter(planAtom)).toMatchObject({ id: 'legacy-plan' })
    expect(store.getter(executionGraphAtom)).toEqual(legacy.executionGraph)
    expect(store.getter(runAtom)).toEqual(recovery.run)
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })

  it('normalizes only process-live run statuses and retains waiting payloads exactly', () => {
    for (const status of ['running', 'awaiting_tool', 'interrupted'] as const) {
      const normalized = normalizeRecoverySnapshotForHydration(snapshot('s1', status))
      expect(normalized.values.run).toMatchObject({ status: 'interrupted', pendingQuestion: { question: 'continue?' } })
      expect(normalized.values.run).not.toHaveProperty('pendingExecutionId')
    }
    for (const status of ['waiting_user', 'waiting_confirmation', 'waiting_plan_approval'] as const) {
      const source = snapshot('s1', status)
      expect(normalizeRecoverySnapshotForHydration(source)).toBe(source)
    }
  })

  it('reconstructs a root session from v1 when the session list is missing or unreadable', async () => {
    const history = createMemoryHistoryDriver()
    const record = snapshot('orphan', 'waiting_confirmation')

    await expect(hydrate({
      sessions: { loadSessions: async () => { throw new Error('legacy list unavailable') } }, history,
      recovery: recoveryDriver({}, [record]),
    })).resolves.toBe(true)

    const store = getSessionStore('orphan').store
    expect(rootStore.getter(sessionsAtom).orphan).toMatchObject(record.session)
    expect(rootStore.getter(sessionsAtom).orphan).not.toHaveProperty('plan')
    expect(rootStore.getter(sessionsAtom).orphan).not.toHaveProperty('executionGraph')
    expect(store.getter(itemsAtom)).toEqual(record.values.conversation.items)
    expect(store.getter(planAtom)).toEqual(record.values.plan.current)
    expect(store.getter(pendingQuestionAnswersAtom)).toEqual(record.values.pendingQuestionAnswers)
    expect(store.getter(runAtom)).toEqual(record.values.run)
  })
})
