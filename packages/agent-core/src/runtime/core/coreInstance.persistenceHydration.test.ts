import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../state/core.type'
import type { SessionsPersistence } from '../../state/persistence/contract'
import { createMemoryRecoveryDriver } from '../../state/persistence/recoveryDriver'
import { sessionsAtom } from '../../state/rootAtoms'
import { itemsAtom } from '../../state/sessionAtoms'
import { createCoreInstance, defaultCore } from './coreInstance'

const sessionId = 'instance-scoped-recovery-hydration'
const meta: SessionMeta = {
  id: sessionId,
  title: 'Instance-scoped recovery',
  settings: { vendor: 'deepseek', model: 'test' },
  createdAt: 1,
  updatedAt: 1,
}

function emptySessionsDriver(): SessionsPersistence {
  return {
    loadSessions: async () => [],
    saveSessions: async () => {},
    loadWorkspaces: async () => [],
    saveWorkspaces: async () => {},
  }
}

describe('CoreInstance persistence hydration', () => {
  it('hydrates Core B from Core A recovery without allocating an unknown session or touching defaultCore', async () => {
    const recovery = createMemoryRecoveryDriver()
    const sessions = emptySessionsDriver()
    const coreA = createCoreInstance()
    coreA.rootStore.setter(sessionsAtom, { [sessionId]: meta })
    coreA.getSessionStore(sessionId).store.setter(itemsAtom, [{
      id: 'item-1',
      createdAt: 1,
      item: { role: 'user', content: 'resume this exact turn' },
    }])
    coreA.persistence.configure({
      sessions,
      recovery,
      recoveryStore: (id) => coreA.findSessionStore(id)?.store,
    })

    expect(coreA.findSessionStore('unknown-session')).toBeUndefined()
    await expect(coreA.persistence.persistRecovery('unknown-session')).resolves.toBeUndefined()
    expect(coreA.findSessionStore('unknown-session')).toBeUndefined()
    await expect(coreA.persistence.persistRecovery(sessionId)).resolves.toMatchObject({ status: 'saved' })
    await coreA.persistence.flushRecovery()

    const coreB = createCoreInstance()
    coreB.persistence.configure({
      sessions,
      recovery,
      recoveryStore: (id) => coreB.findSessionStore(id)?.store,
    })
    expect(defaultCore.rootStore.getter(sessionsAtom)[sessionId]).toBeUndefined()
    expect(defaultCore.findSessionStore(sessionId)).toBeUndefined()

    await expect(coreB.persistence.hydrate()).resolves.toBe(true)

    expect(coreB.rootStore.getter(sessionsAtom)[sessionId]).toMatchObject(meta)
    expect(coreB.findSessionStore(sessionId)?.store.getter(itemsAtom)).toEqual([{
      id: 'item-1',
      createdAt: 1,
      item: { role: 'user', content: 'resume this exact turn' },
    }])
    expect(defaultCore.rootStore.getter(sessionsAtom)[sessionId]).toBeUndefined()
    expect(defaultCore.findSessionStore(sessionId)).toBeUndefined()
  })
})
