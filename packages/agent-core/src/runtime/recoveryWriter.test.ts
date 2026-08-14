import { createStore, type Store } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { ObservabilityPort } from '../observability/port'
import type { SessionMeta } from '../state/core.type'
import { captureRecoverySnapshot } from '../state/recoveryProjection'
import {
  createMemoryRecoveryDriver,
  type RecoveryDriver,
  type RecoverySaveResult,
} from '../state/persistence/recoveryDriver'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createRecoveryWriter } from './recoveryWriter'

function testObservability() {
  const finish = vi.fn(() => 0)
  const port = {
    beginPerformanceDiagnostic: vi.fn(() => ({ operationId: 'test', finish })),
  } as Pick<ObservabilityPort, 'beginPerformanceDiagnostic'>
  return { port, finish }
}

function memoryDriver(overrides: Partial<RecoveryDriver> = {}): RecoveryDriver {
  return { ...createMemoryRecoveryDriver(), ...overrides }
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

function snapshot(
  store: Store,
  rootStore: Store,
  sessionId: string,
  generation: number,
): RecoverySnapshotV1 {
  return captureRecoverySnapshot(store, { rootStore, sessionId, generation, capturedAt: 1 })
}

function recoveryStore(item = 'before'): Store {
  const store = createStore()
  store.setter(itemsAtom, [{
    id: 'item-1',
    createdAt: 1,
    item: { role: 'user', content: item },
  }])
  return store
}

describe('recoveryWriter', () => {
  it('captures atom state synchronously before an async driver queue can observe later changes', async () => {
    let releaseLoad: (() => void) | undefined
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const base = memoryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const driver = memoryDriver({
      loadLatest: async (id) => {
        await loadGate
        return base.loadLatest(id)
      },
      saveLatest,
    })
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({ rootStore, recovery: driver, observability: diagnostics.port })
    const store = recoveryStore('before')

    const write = writer.persist(store, 's1', 'turn.complete')
    store.setter(itemsAtom, [{
      id: 'item-2',
      createdAt: 2,
      item: { role: 'user', content: 'after' },
    }])
    releaseLoad?.()

    await expect(write).resolves.toMatchObject({ status: 'saved', generation: 1 })
    await expect(base.loadLatest('s1')).resolves.toMatchObject({
      values: { conversation: { items: [{ item: { content: 'before' } }] } },
    })
    expect(saveLatest).toHaveBeenCalledTimes(1)
  })

  it('derives a strictly newer generation from the durable record', async () => {
    const base = memoryDriver()
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({ rootStore, recovery: base, observability: diagnostics.port })
    const store = recoveryStore()
    await base.saveLatest('s1', snapshot(store, rootStore, 's1', 9))

    await expect(writer.persist(store, 's1')).resolves.toEqual({
      status: 'saved',
      sessionId: 's1',
      generation: 10,
      attempts: 1,
    })
  })

  it('reloads and retries a stale CAS with a greater durable generation', async () => {
    const base = memoryDriver()
    const rootStore = rootStoreFor()
    const store = recoveryStore()
    await base.saveLatest('s1', snapshot(store, rootStore, 's1', 5))
    let staleOnce = true
    const saveLatest = vi.fn(async (
      id: string,
      candidate: RecoverySnapshotV1,
    ): Promise<RecoverySaveResult> => {
      if (staleOnce) {
        staleOnce = false
        await base.saveLatest(id, { ...candidate, generation: 10 })
        return { status: 'stale', currentGeneration: 10 }
      }
      return base.saveLatest(id, candidate)
    })
    const driver: RecoveryDriver = { ...base, saveLatest }
    const diagnostics = testObservability()
    const writer = createRecoveryWriter({ rootStore, recovery: driver, observability: diagnostics.port })

    await expect(writer.persist(store, 's1')).resolves.toEqual({
      status: 'saved',
      sessionId: 's1',
      generation: 11,
      attempts: 2,
    })
    expect(saveLatest.mock.calls.map(([, candidate]) => candidate.generation)).toEqual([6, 11])
  })

  it('reports a capture validation failure without a durable write', async () => {
    const base = memoryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: memoryDriver({ saveLatest }),
      observability: diagnostics.port,
    })
    const store = createStore()
    store.setter(runAtom, { runId: 'bad', status: 'waiting_user', pendingQuestion: () => undefined })

    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'error', sessionId: 's1' })
    expect(saveLatest).not.toHaveBeenCalled()
    expect(diagnostics.finish).toHaveBeenCalledWith('error', expect.any(Object), expect.any(Error))
  })

  it('publishes a driver error through the writer outcome and observability', async () => {
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: memoryDriver({ loadLatest: async () => { throw new Error('disk unavailable') } }),
      observability: diagnostics.port,
    })

    await expect(writer.persist(recoveryStore(), 's1')).resolves.toMatchObject({ status: 'error' })
    expect(diagnostics.finish).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ sessionId: 's1', outcome: 'error' }),
      expect.objectContaining({ message: 'disk unavailable' }),
    )
  })

  it('fences queued and later writes once deletion is requested', async () => {
    let releaseLoad: (() => void) | undefined
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const base = memoryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const driver = memoryDriver({
      loadLatest: async (id) => {
        await loadGate
        return base.loadLatest(id)
      },
      saveLatest,
    })
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({ rootStore, recovery: driver, observability: diagnostics.port })
    const store = recoveryStore()

    const beforeDelete = writer.persist(store, 's1')
    const deletion = writer.deleteSession('s1')
    releaseLoad?.()

    await expect(beforeDelete).resolves.toEqual({ status: 'tombstoned', sessionId: 's1' })
    await expect(deletion).resolves.toEqual({ status: 'deleted', sessionId: 's1' })
    await expect(base.loadLatest('s1')).resolves.toBeUndefined()
    await expect(writer.persist(store, 's1')).resolves.toEqual({ status: 'tombstoned', sessionId: 's1' })
    expect(saveLatest).not.toHaveBeenCalled()
  })

  it('reset drops queued work before it can save', async () => {
    let releaseLoad: (() => void) | undefined
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    const base = memoryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const diagnostics = testObservability()
    const rootStore = rootStoreFor()
    const writer = createRecoveryWriter({
      rootStore,
      recovery: memoryDriver({
        loadLatest: async (id) => {
          await loadGate
          return base.loadLatest(id)
        },
        saveLatest,
      }),
      observability: diagnostics.port,
    })

    const write = writer.persist(recoveryStore(), 's1')
    writer.reset()
    releaseLoad?.()

    await expect(write).resolves.toEqual({ status: 'skipped', sessionId: 's1', reason: 'reset' })
    expect(saveLatest).not.toHaveBeenCalled()
  })

})
