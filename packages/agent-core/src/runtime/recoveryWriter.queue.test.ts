// RecoveryWriter 的队列生命周期：同会话串行、故障后的继续与有序关闭。

import { createStore, type Store } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { ObservabilityPort } from '../observability/port'
import type { SessionMeta } from '../state/core.type'
import {
  createMemoryRecoveryDriver,
  type RecoveryDriver,
} from '../state/persistence/recoveryDriver'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import { createRecoveryWriter } from './recoveryWriter'

function observability(): Pick<ObservabilityPort, 'beginPerformanceDiagnostic'> {
  return {
    beginPerformanceDiagnostic: vi.fn(() => ({ operationId: 'test', finish: vi.fn(() => 0) })),
  }
}

function rootStoreFor(sessionId = 's1'): Store {
  const store = createStore()
  const session: SessionMeta = {
    id: sessionId,
    title: 'Recovery test',
    settings: { vendor: 'deepseek', model: 'test' },
    createdAt: 1,
    updatedAt: 1,
  }
  store.setter(sessionsAtom, { [sessionId]: session })
  return store
}

function recoveryStore(): Store {
  const store = createStore()
  store.setter(itemsAtom, [{
    id: 'item-1',
    createdAt: 1,
    item: { role: 'user', content: 'before' },
  }])
  return store
}

describe('recoveryWriter queue lifecycle', () => {
  it('serializes consecutive writes for one session', async () => {
    const base = createMemoryRecoveryDriver()
    let activeSaves = 0
    let maximumActiveSaves = 0
    const saveLatest = vi.fn(async (id: string, candidate: RecoverySnapshotV1) => {
      activeSaves += 1
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves)
      await Promise.resolve()
      activeSaves -= 1
      return base.saveLatest(id, candidate)
    })
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: { ...base, saveLatest },
      observability: observability(),
    })
    const store = recoveryStore()

    const [first, second] = await Promise.all([writer.persist(store, 's1'), writer.persist(store, 's1')])

    expect([first, second]).toMatchObject([
      { status: 'saved', generation: 1 },
      { status: 'saved', generation: 2 },
    ])
    expect(maximumActiveSaves).toBe(1)
  })

  it('continues with a later write after a driver failure', async () => {
    const base = createMemoryRecoveryDriver()
    let failOnce = true
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: {
        ...base,
        loadLatest: async (id) => {
          if (failOnce) {
            failOnce = false
            throw new Error('temporary failure')
          }
          return base.loadLatest(id)
        },
      },
      observability: observability(),
    })
    const store = recoveryStore()

    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'error' })
    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved', generation: 2 })
  })

  it('flush waits for writes queued before orderly shutdown', async () => {
    let releaseLoad: (() => void) | undefined
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const base = createMemoryRecoveryDriver()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: recoveryDriverWithLoadGate(base, loadGate),
      observability: observability(),
    })

    void writer.persist(recoveryStore(), 's1')
    let flushed = false
    const flush = writer.flush().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)

    releaseLoad?.()
    await flush
    await expect(base.loadLatest('s1')).resolves.toMatchObject({ generation: 1 })
  })
})

function recoveryDriverWithLoadGate(
  base: RecoveryDriver,
  loadGate: Promise<void>,
): RecoveryDriver {
  return {
    ...base,
    loadLatest: async (id) => {
      await loadGate
      return base.loadLatest(id)
    },
  }
}
