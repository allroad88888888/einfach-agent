import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCoreInstance, defaultCore } from '../runtime/core/coreInstance'
import { configurePersistence, resetPersistence } from '../runtime/persistenceBridge'
import { sessionsAtom } from '../state/rootStore'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import { getExecutionRuntime } from './runtime'

function createSessionsPersistence() {
  const saveSessions = vi.fn(async (_sessions: SessionMeta[]) => {})
  return {
    saveSessions,
    loadSessions: vi.fn(async () => [] as SessionMeta[]),
    saveWorkspaces: vi.fn(async (_workspaces: WorkspaceMeta[]) => {}),
    loadWorkspaces: vi.fn(async () => [] as WorkspaceMeta[]),
  } satisfies SessionsPersistence
}

function sessionMeta(id: string): SessionMeta {
  return {
    id,
    title: id,
    settings: { vendor: 'deepseek', model: 'test' },
    createdAt: 0,
    updatedAt: 0,
  }
}

afterEach(() => {
  resetPersistence()
})

describe('execution runtime persistence isolation', () => {
  it('persists an isolated core execution graph through that core bridge, never defaultCore', async () => {
    const defaultSessions = createSessionsPersistence()
    const aSessions = createSessionsPersistence()
    configurePersistence({ sessions: defaultSessions })

    const A = createCoreInstance()
    A.persistence.configure({ sessions: aSessions })
    A.rootStore.setter(sessionsAtom, { 'instance-a': sessionMeta('instance-a') })
    defaultCore.rootStore.setter(sessionsAtom, { default: sessionMeta('default') })

    await getExecutionRuntime(A).run({
      id: 'node-a',
      graphId: 'run-a',
      sessionId: 'instance-a',
      runId: 'run-a',
      type: 'tool',
      label: 'A only',
      task: async () => 'done',
    })

    expect(aSessions.saveSessions).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'instance-a',
        executionGraph: expect.objectContaining({
          order: ['node-a'],
          nodes: expect.objectContaining({
            'node-a': expect.objectContaining({ status: 'succeeded' }),
          }),
        }),
      }),
    ])
    expect(defaultSessions.saveSessions).not.toHaveBeenCalled()
  })
})
