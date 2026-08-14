import { describe, expect, it, vi } from 'vitest'

import {
  childContinuationDescriptorJson,
  createChildContinuationDescriptor,
  terminalChildContinuationDescriptor,
} from '../subagents/continuationDescriptor'
import { createTestDelegationCapability } from '../subagents/runtime.ports.testFixtures'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from '../subagents/types'
import type { SessionMeta } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import { createMemoryHistoryDriver } from '../state/persistence/memoryHistoryDriver'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'
import type { SubagentContinuationV1 } from '../state/recoverySnapshot.type'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
import { createCore } from './core/createCore'

type Core = ReturnType<typeof createCore>
type ChildKind = 'queued' | 'outcome_unknown' | 'terminal' | 'malformed'

function memorySessions(): SessionsPersistence {
  let rows: SessionMeta[] = []
  return {
    async saveSessions(next) { rows = next },
    async loadSessions() { return rows },
    async saveWorkspaces() {},
    async loadWorkspaces() { return [] },
  }
}

function wirePersistence(core: Core, sessions: SessionsPersistence, recovery: RecoveryDriver): void {
  core.persistence.configure({
    sessions,
    history: createMemoryHistoryDriver(),
    recovery,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
  })
}

function respondingCore(requests: { count: number }): Core {
  return createCore({
    delegation: createTestDelegationCapability,
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

function seedInterruptedRoot(core: Core, sessionId: string): void {
  const store = core.getSessionStore(sessionId).store
  store.setter(itemsAtom, [{
    id: 'user-1', createdAt: 1, item: { role: 'user', content: 'resume the root' },
  }])
  store.setter(runAtom, { runId: 'root-run', status: 'interrupted', turnId: 'user-1', startedAt: 1 })
}

function childNode(sessionId: string): SubagentNodeRecord {
  return {
    id: 'child-run:root-01',
    treeId: 'child-run',
    sessionId,
    path: 'root-01',
    parentPath: 'root',
    delegationCallId: 'delegate-1',
    status: 'queued',
    objective: 'inspect the child',
    depth: 1,
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: 1,
    updatedAt: 1,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function childContinuation(sessionId: string, kind: ChildKind): SubagentContinuationV1 {
  const task: DelegateAgentChildSpec = { objective: 'inspect the child' }
  const node = childNode(sessionId)
  const active = createChildContinuationDescriptor(node, task)
  const descriptor = kind === 'terminal'
    ? terminalChildContinuationDescriptor({
      descriptor: active,
      kind: 'done',
      summary: 'the child finished before interruption',
      resultArchivePath: 'archive/child.md',
      skillFiles: [],
      skillIds: [],
      changeSets: [],
    })
    : active
  return {
    schemaVersion: 1,
    childId: node.id,
    parentRunId: node.treeId,
    parentNodeId: null,
    state: kind === 'outcome_unknown' ? 'outcome_unknown' : 'queued',
    spec: kind === 'malformed' ? { version: 1, malformed: true } : childContinuationDescriptorJson(descriptor),
  }
}

async function persistRoot(core: Core, sessionId: string, sessions: SessionsPersistence): Promise<void> {
  await sessions.saveSessions(Object.values(core.rootStore.getter(sessionsAtom)))
  await core.persistence.persistRecovery(sessionId)
  await core.persistence.flushRecovery()
}

describe('child continuation recovery', () => {
  it('continues a normally interrupted root after a separate Core hydrates it', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const origin = createCore()
    wirePersistence(origin, sessions, recovery)
    const sessionId = origin.newSession({ settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' } })
    seedInterruptedRoot(origin, sessionId)
    await persistRoot(origin, sessionId, sessions)

    const requests = { count: 0 }
    const restored = respondingCore(requests)
    wirePersistence(restored, sessions, recovery)
    await expect(restored.persistence.hydrate()).resolves.toBe(true)

    expect(restored.continueRecoveredSession(sessionId)).toEqual({
      status: 'continued', sessionId, continuation: 'interrupted_run',
    })
    await vi.waitFor(() => expect(requests.count).toBe(1))
  })

  it.each<ChildKind>(['queued', 'outcome_unknown', 'terminal', 'malformed'])(
    'hydrates a %s child descriptor without dispatching or replaying it',
    async (kind) => {
      const sessions = memorySessions()
      const recovery = createMemoryRecoveryDriver()
      const origin = createCore()
      wirePersistence(origin, sessions, recovery)
      const sessionId = origin.newSession({ settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' } })
      seedInterruptedRoot(origin, sessionId)
      const continuation = childContinuation(sessionId, kind)
      origin.getSessionStore(sessionId).store.setter(subagentContinuationsAtom, [continuation])
      await persistRoot(origin, sessionId, sessions)

      const requests = { count: 0 }
      const restored = respondingCore(requests)
      wirePersistence(restored, sessions, recovery)
      await expect(restored.persistence.hydrate()).resolves.toBe(true)
      const store = restored.getSessionStore(sessionId).store
      const itemsBefore = structuredClone(store.getter(itemsAtom))
      const continuationsBefore = structuredClone(store.getter(subagentContinuationsAtom))
      const schedulerEvents: SubagentNodeRecord[] = []
      const unsubscribe = restored.delegation!.scheduler.subscribe((node) => schedulerEvents.push(node))

      expect(restored.continueRecoveredSession(sessionId)).toEqual({
        status: 'reconciliation_required', sessionId, reason: 'subagent_continuation',
      })
      await Promise.resolve()
      unsubscribe()

      expect(requests.count).toBe(0)
      expect(schedulerEvents).toEqual([])
      expect(restored.delegation!.scheduler.snapshot('child-run')).toEqual([])
      expect(store.getter(itemsAtom)).toEqual(itemsBefore)
      expect(store.getter(subagentContinuationsAtom)).toEqual(continuationsBefore)
    },
  )
})
