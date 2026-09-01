import { createStore, type Store } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRolloutDriver } from '../history'
import { createObservabilityPort } from '../observability/port'
import type { SessionMeta } from '../state/core.type'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCore } from './core/createCore'
import { startModelRun } from './modelRunLifecycle'
import { createRecoveryWriter } from './recoveryWriter'

function stores(): { rootStore: Store; store: Store } {
  const rootStore = createStore()
  const session: SessionMeta = {
    id: 's1', title: 'Test', settings: { vendor: 'v', model: 'm' }, createdAt: 1, updatedAt: 1,
  }
  rootStore.setter(sessionsAtom, { s1: session })
  const store = createStore()
  store.setter(itemsAtom, [{ id: 'a', createdAt: 1, item: { role: 'user', content: 'A' } }])
  return { rootStore, store }
}

function rollout(append = vi.fn(async () => ({ records: [] }))): AgentRolloutDriver {
  return { append, reconcile: async () => ({ histories: [] }), flush: async () => {} }
}

describe('recoveryWriter rollout durability', () => {
  it('returns rollout failure before touching recovery and retries the full backfill', async () => {
    const { rootStore, store } = stores()
    const base = createMemoryRecoveryDriver()
    const saveLatest = vi.fn(base.saveLatest)
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('rollout unavailable'))
      .mockResolvedValue({ records: [] })
    const writer = createRecoveryWriter({
      rootStore, recovery: { ...base, saveLatest }, observability: createObservabilityPort(), agentRollout: rollout(append),
    })

    await expect(writer.persist(store, 's1')).resolves.toMatchObject({
      status: 'error', error: expect.objectContaining({ message: 'rollout unavailable' }),
    })
    expect(saveLatest).not.toHaveBeenCalled()
    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved' })
    expect(append.mock.calls[1][1]).toHaveLength(4)
  })

  it('isolates an old in-flight append from the coordinator created by reset', async () => {
    const { rootStore, store } = stores()
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const append = vi.fn(async () => {
      if (append.mock.calls.length === 1) await firstGate
      return { records: [] }
    })
    const writer = createRecoveryWriter({
      rootStore,
      recovery: createMemoryRecoveryDriver(),
      observability: createObservabilityPort(),
      agentRollout: rollout(append),
    })

    const oldLifecycle = writer.persist(store, 's1')
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1))
    writer.reset()
    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved' })
    releaseFirst?.()
    await expect(oldLifecycle).resolves.toMatchObject({ status: 'skipped' })
    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved' })

    expect(append).toHaveBeenCalledTimes(2)
  })

  it('lets the model fence block on rollout error outcome without an unhandled rejection', async () => {
    const core = createCore()
    const id = core.newSession({ settings: { vendor: 'v', model: 'm' } })
    const base = createMemoryRecoveryDriver()
    core.persistence.configure({
      recovery: base,
      recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
      agentRollout: rollout(vi.fn(async () => { throw new Error('rollout unavailable') })),
    })
    const runLoop = vi.fn(async () => {})

    await startModelRun(id, 'hello', { signal: new AbortController().signal, apiKey: 'key', core }, runLoop)

    expect(runLoop).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(runAtom)).toMatchObject({
      status: 'interrupted', error: 'Recovery persistence failed before model execution.',
    })
  })

  it('preserves recovery behavior when rollout is unconfigured', async () => {
    const { rootStore, store } = stores()
    const writer = createRecoveryWriter({
      rootStore, recovery: createMemoryRecoveryDriver(), observability: createObservabilityPort(),
    })

    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved' })
  })

  it('retains an appended rollout when recovery fails and does not append it again on retry', async () => {
    const { rootStore, store } = stores()
    const base = createMemoryRecoveryDriver()
    let fail = true
    const recovery: RecoveryDriver = {
      ...base,
      saveLatest: async (id, snapshot) => {
        if (fail) { fail = false; throw new Error('recovery unavailable') }
        return base.saveLatest(id, snapshot)
      },
    }
    const append = vi.fn(async () => ({ records: [] }))
    const writer = createRecoveryWriter({
      rootStore, recovery, observability: createObservabilityPort(), agentRollout: rollout(append),
    })

    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'error' })
    await expect(writer.persist(store, 's1')).resolves.toMatchObject({ status: 'saved' })
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('does not delete rollout and clears its previous state on session deletion', async () => {
    const { rootStore, store } = stores()
    const append = vi.fn(async () => ({ records: [] }))
    const agentRollout = rollout(append)
    const deleteRollout = vi.spyOn(agentRollout as AgentRolloutDriver & { delete?: () => void }, 'flush')
    const writer = createRecoveryWriter({
      rootStore, recovery: createMemoryRecoveryDriver(), observability: createObservabilityPort(), agentRollout,
    })

    await writer.persist(store, 's1')
    await writer.deleteSession('s1')
    expect(deleteRollout).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledTimes(1)
  })
})
