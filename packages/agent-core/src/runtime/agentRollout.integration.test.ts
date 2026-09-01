import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'

import type { AgentRolloutDriver } from '../history'
import { createObservabilityPort } from '../observability/port'
import type { SessionMeta } from '../state/core.type'
import { createMemoryRecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import { createChildRolloutRecorder } from '../subagents/childRolloutRecorder'
import { createRecoveryWriter } from './recoveryWriter'

function stores() {
  const rootStore = createStore()
  const store = createStore()
  const meta: SessionMeta = {
    id: 'session', title: 'Session', settings: { vendor: 'v', model: 'm' }, createdAt: 1, updatedAt: 2,
  }
  rootStore.setter(sessionsAtom, { session: meta })
  store.setter(itemsAtom, [{ id: 'a', createdAt: 1, item: { role: 'user', content: 'A' } }])
  return { rootStore, store }
}

function observingDriver() {
  const append = vi.fn(async () => ({ records: [] }))
  const driver: AgentRolloutDriver = {
    append, reconcile: vi.fn(async () => ({ histories: [] })), flush: vi.fn(async () => undefined),
  }
  return { append, driver }
}

describe('agent rollout lifecycle integration', () => {
  it('does not append for recovery generation-only changes or session deletion', async () => {
    const { append, driver } = observingDriver()
    const { rootStore, store } = stores()
    const writer = createRecoveryWriter({
      rootStore, recovery: createMemoryRecoveryDriver(), observability: createObservabilityPort(), agentRollout: driver,
    })
    expect(await writer.persist(store, 'session')).toMatchObject({ status: 'saved', generation: 1 })
    expect(append).toHaveBeenCalledTimes(1)
    expect(await writer.persist(store, 'session')).toMatchObject({ status: 'saved', generation: 2 })
    expect(append).toHaveBeenCalledTimes(1)
    expect(await writer.deleteSession('session')).toMatchObject({ status: 'deleted' })
    expect(await writer.persist(store, 'session')).toMatchObject({ status: 'tombstoned' })
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('runs the static child recorder without a driver or synthetic completion record', async () => {
    const recorder = createChildRolloutRecorder({
      conversationId: 'static', runId: 'run', agentPath: 'root-01', now: () => 1,
    })
    await expect(recorder.recordInitial([{ role: 'system', content: 'static' }])).resolves.toBeUndefined()
    await expect(recorder.recordSuccess()).resolves.toBeUndefined()
  })
})
