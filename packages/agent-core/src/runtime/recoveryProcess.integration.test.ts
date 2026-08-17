import { describe, expect, it, vi } from 'vitest'

import { executionGraphAtom } from '../execution/graph'
import type { SessionMeta } from '../state/core.type'
import { setPlan } from '../state/planWriters'
import type { SessionsPersistence } from '../state/persistence/contract'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import { activeSessionIdAtom, sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, planAtom, runAtom } from '../state/sessionAtoms'
import { composerDraftAtom } from '../state/sessionTransientAtoms'
import { createCore } from './core/createCore'

type Core = ReturnType<typeof createCore>

function memorySessions(initial: SessionMeta[] = []): SessionsPersistence {
  let rows = initial
  return {
    async saveSessions(next) { rows = next },
    async loadSessions() { return rows },
    async saveWorkspaces() {},
    async loadWorkspaces() { return [] },
  }
}

function configure(core: Core, sessions: SessionsPersistence, recovery: RecoveryDriver): void {
  core.persistence.configure({
    sessions,
    recovery,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
  })
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
        status: 'interrupted' as const, label: id, attempt: 1, generation: 1, effectKeys: [],
        createdAt: 1, updatedAt: 2,
      },
    },
    order: [id],
  }
}

function respondingCore(requests: { count: number }): Core {
  return createCore({
    config: {
      modelCredentials: { deepseek: 'test-key' },
      fetchImpl: async () => {
        requests.count += 1
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'continued' } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    },
  })
}

async function persistSessions(core: Core, sessions: SessionsPersistence): Promise<void> {
  await sessions.saveSessions(Object.values(core.rootStore.getter(sessionsAtom)))
}

describe('recovery process reconstruction', () => {
  it('hydrates a clean v1 snapshot and resumes the explicit session without changing selection', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const coreA = createCore()
    configure(coreA, sessions, recovery)
    const recovered = coreA.newSession({ settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' } })
    const selected = coreA.newSession({ settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' } })
    const source = coreA.getSessionStore(recovered).store
    source.setter(itemsAtom, [{ id: 'user-1', createdAt: 1, item: { role: 'user', content: 'resume me' } }])
    source.setter(runAtom, { runId: 'run-1', status: 'interrupted', turnId: 'user-1' })
    await persistSessions(coreA, sessions)
    await coreA.persistence.persistRecovery(recovered)
    await coreA.persistence.flushRecovery()

    const requests = { count: 0 }
    const coreB = respondingCore(requests)
    configure(coreB, sessions, recovery)
    await expect(coreB.persistence.hydrate()).resolves.toBe(true)
    expect(coreB.getSessionStore(recovered).store.getter(itemsAtom)).toEqual(source.getter(itemsAtom))
    expect(coreB.getSessionStore(recovered).store.getter(runAtom)).toMatchObject({
      runId: 'run-1', status: 'interrupted', turnId: 'user-1',
    })

    coreB.selectSession(selected)
    expect(coreB.continueRecoveredSession(recovered)).toEqual({
      status: 'continued', sessionId: recovered, continuation: 'interrupted_run',
    })
    expect(coreB.rootStore.getter(activeSessionIdAtom)).toBe(selected)
    await vi.waitFor(() => expect(requests.count).toBe(1))
  })

  it('restores live atoms only from a valid v1 projection', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const coreA = createCore()
    configure(coreA, sessions, recovery)
    const id = coreA.newSession({ settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' } })
    const source = coreA.getSessionStore(id).store
    source.setter(itemsAtom, [{ id: 'v1-item', createdAt: 1, item: { role: 'user', content: 'v1 truth' } }])
    source.setter(runAtom, { runId: 'v1-run', status: 'waiting_user' })
    setPlan(id, plan('v1-plan'), coreA)
    source.setter(executionGraphAtom, graph(id, 'v1-node'))
    await coreA.persistence.persistRecovery(id)
    await coreA.persistence.flushRecovery()

    await persistSessions(coreA, sessions)
    const coreB = createCore()
    configure(coreB, sessions, recovery)
    await expect(coreB.persistence.hydrate()).resolves.toBe(true)
    const hydrated = coreB.getSessionStore(id).store
    expect(hydrated.getter(itemsAtom)[0]?.item).toMatchObject({ content: 'v1 truth' })
    expect(hydrated.getter(planAtom)?.id).toBe('v1-plan')
    expect(hydrated.getter(executionGraphAtom).order).toEqual(['v1-node'])
  })

  // 撤回把用户原话从 items 截断、放回输入框。那一刻 composer 是它唯一的副本，
  // 同一条命令提交的 generation 必须带上它，否则重启就是纯粹的用户数据丢失。
  it('keeps a no-v1 session static with undo history and no recovery dispatch', async () => {
    const id = 'no-v1'
    const sessions = memorySessions([{
      id, title: 'No v1', settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' }, createdAt: 1, updatedAt: 2,
    }])
    const recovery = createMemoryRecoveryDriver()
    const requests = { count: 0 }
    const coreB = respondingCore(requests)
    coreB.persistence.configure({
      sessions, recovery, recoveryStore: (sessionId) => coreB.findSessionStore(sessionId)?.store,
    })

    await expect(coreB.persistence.hydrate()).resolves.toBe(true)
    await expect(recovery.loadLatest(id)).resolves.toBeUndefined()
    const restored = coreB.getSessionStore(id).store
    expect(restored.getter(itemsAtom)).toEqual([])
    expect(restored.getter(runAtom)).toBeUndefined()
    expect(coreB.continueRecoveredSession(id)).toEqual({
      status: 'unavailable', sessionId: id, reason: 'nonrecoverable',
    })
    expect(requests.count).toBe(0)
  })

  it('keeps a corrupt-v1 session static with undo history and no recovery dispatch', async () => {
    const id = 'corrupt-v1'
    const sessions = memorySessions([{
      id, title: 'Corrupt v1', settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' }, createdAt: 1, updatedAt: 2,
    }])
    const corrupt: RecoveryDriver = {
      async listLatest() { return [{ sessionId: id, schemaVersion: 1 }] as RecoverySnapshotV1[] },
      async loadLatest() { return { sessionId: id, schemaVersion: 1 } as RecoverySnapshotV1 },
      async saveLatest(_id, snapshot) { return { status: 'saved', generation: snapshot.generation } },
      async deleteSession() {},
    }
    const requests = { count: 0 }
    const coreB = respondingCore(requests)
    coreB.persistence.configure({
      sessions, recovery: corrupt, recoveryStore: (sessionId) => coreB.findSessionStore(sessionId)?.store,
    })

    await expect(coreB.persistence.hydrate()).resolves.toBe(true)
    const hydrated = coreB.getSessionStore(id).store
    expect(hydrated.getter(itemsAtom)).toEqual([])
    expect(hydrated.getter(planAtom)).toBeUndefined()
    expect(hydrated.getter(runAtom)).toBeUndefined()
    expect(coreB.continueRecoveredSession(id)).toMatchObject({ status: 'unavailable', reason: 'nonrecoverable' })
    await Promise.resolve()
    expect(requests.count).toBe(0)
  })
})
