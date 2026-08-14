// RecoveryWriter 与持久化桥的显式调用边界。

import { createStore, type Store } from '@einfach/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createObservabilityPort } from '../observability/port'
import type { SessionMeta } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import { captureRecoverySnapshot } from '../state/recoveryProjection'
import {
  createMemoryRecoveryDriver,
  type RecoveryDriver,
} from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import {
  configurePersistence,
  createPersistenceBridge,
  hydratePersistence,
  resetPersistence,
} from './persistenceBridge'

const meta: SessionMeta = {
  id: 's1',
  title: 'Recovery test',
  settings: { vendor: 'deepseek', model: 'test' },
  createdAt: 1,
  updatedAt: 1,
}

function rootStoreFor(): Store {
  const store = createStore()
  store.setter(sessionsAtom, { s1: meta })
  return store
}

function sessionStoreFor(): Store {
  const store = createStore()
  store.setter(itemsAtom, [{
    id: 'item-1',
    createdAt: 1,
    item: { role: 'user', content: 'interrupted work' },
  }])
  return store
}

async function waitForSnapshot(recovery: RecoveryDriver): Promise<void> {
  await vi.waitFor(async () => {
    expect(await recovery.loadLatest('s1')).toBeDefined()
  })
}

function historyDriver() {
  return {
    listCheckpoints: async () => [],
    loadCheckpoint: async () => undefined,
    saveCheckpoint: async () => {},
    truncateAfter: async () => {},
    deleteSession: async () => {},
  }
}

function sessionsDriver(): SessionsPersistence {
  return {
    loadSessions: async () => [],
    saveSessions: async () => {},
    loadWorkspaces: async () => [],
    saveWorkspaces: async () => {},
  }
}

afterEach(() => {
  resetPersistence()
  vi.clearAllMocks()
})

describe('persistenceBridge recovery facade', () => {
  it('is a no-op until both recovery driver and extant-session locator are configured', async () => {
    const rootStore = rootStoreFor()
    const recovery = createMemoryRecoveryDriver()
    const bridge = createPersistenceBridge(rootStore, createObservabilityPort())

    bridge.persistRecovery('s1')
    bridge.configure({ recovery })
    bridge.persistRecovery('s1')

    await expect(recovery.loadLatest('s1')).resolves.toBeUndefined()
  })

  it('persists only when its explicit recovery facade is invoked', async () => {
    const rootStore = rootStoreFor()
    const sessionStore = sessionStoreFor()
    const recovery = createMemoryRecoveryDriver()
    const bridge = createPersistenceBridge(rootStore, createObservabilityPort())
    bridge.configure({ recovery, recoveryStore: (id) => id === 's1' ? sessionStore : undefined })

    await expect(recovery.loadLatest('s1')).resolves.toBeUndefined()
    bridge.persistRecovery('missing-session')
    bridge.persistRecovery('s1', 'turn.complete')

    await waitForSnapshot(recovery)
    await expect(recovery.loadLatest('s1')).resolves.toMatchObject({
      session: { id: 's1', title: 'Recovery test' },
      values: { conversation: { items: [{ item: { content: 'interrupted work' } }] } },
    })
  })

  it('routes deletion through the recovery tombstone and cannot resurrect from the facade', async () => {
    const rootStore = rootStoreFor()
    const sessionStore = sessionStoreFor()
    const base = createMemoryRecoveryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const recovery: RecoveryDriver = { ...base, saveLatest }
    const deleteSession = vi.fn(async () => {})
    const bridge = createPersistenceBridge(rootStore, createObservabilityPort())
    bridge.configure({
      recovery,
      recoveryStore: () => sessionStore,
      history: { ...historyDriver(), deleteSession },
    })

    bridge.persistRecovery('s1')
    await waitForSnapshot(recovery)
    expect(saveLatest).toHaveBeenCalledTimes(1)

    bridge.persistDeleteSession('s1')
    bridge.persistRecovery('s1')
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledWith('s1'))
    await vi.waitFor(async () => {
      await expect(recovery.loadLatest('s1')).resolves.toBeUndefined()
    })
    expect(saveLatest).toHaveBeenCalledTimes(1)
  })

  it('flushRecovery waits for the recovery write already queued by its facade', async () => {
    let releaseLoad: (() => void) | undefined
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const rootStore = rootStoreFor()
    const sessionStore = sessionStoreFor()
    const base = createMemoryRecoveryDriver()
    const recovery: RecoveryDriver = {
      ...base,
      loadLatest: async (id) => {
        await loadGate
        return base.loadLatest(id)
      },
    }
    const bridge = createPersistenceBridge(rootStore, createObservabilityPort())
    bridge.configure({ recovery, recoveryStore: () => sessionStore })

    bridge.persistRecovery('s1')
    let flushed = false
    const flush = bridge.flushRecovery().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)

    releaseLoad?.()
    await flush
    await expect(base.loadLatest('s1')).resolves.toMatchObject({ generation: 1 })
  })

  it('passes the configured recovery driver into startup hydrate', async () => {
    const snapshotRoot = rootStoreFor()
    const recovery = createMemoryRecoveryDriver()
    await recovery.saveLatest(
      's1',
      captureRecoverySnapshot(sessionStoreFor(), {
        rootStore: snapshotRoot,
        sessionId: 's1',
        generation: 1,
        capturedAt: 1,
      }),
    )
    configurePersistence({
      recovery,
      history: historyDriver(),
      sessions: sessionsDriver(),
    })

    await expect(hydratePersistence()).resolves.toBe(true)
  })
})
