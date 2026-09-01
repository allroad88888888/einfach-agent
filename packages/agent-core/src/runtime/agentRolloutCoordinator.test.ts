import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRolloutDriver, AgentRolloutMutationV1 } from '../history'
import type { SessionMeta } from '../state/core.type'
import { captureRecoverySnapshot } from '../state/recoveryProjection'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import { createAgentRolloutCoordinator } from './agentRolloutCoordinator'

function fixture() {
  const root = createStore()
  const store = createStore()
  const meta: SessionMeta = {
    id: 's1', title: 'Test', settings: { vendor: 'v', model: 'm' }, createdAt: 1, updatedAt: 1,
  }
  root.setter(sessionsAtom, { s1: meta })
  store.setter(itemsAtom, [{ id: 'a', createdAt: 1, item: { role: 'user', content: 'A' } }])
  return { root, store }
}

function driver(batches: AgentRolloutMutationV1[][]): AgentRolloutDriver {
  return {
    append: vi.fn(async (_target, mutations) => {
      batches.push([...mutations])
      return { records: [] }
    }),
    reconcile: async () => ({ histories: [] }),
    flush: async () => {},
  }
}

describe('agentRolloutCoordinator', () => {
  it('backfills once then emits stable update, reorder, and delete deltas', async () => {
    const batches: AgentRolloutMutationV1[][] = []
    const rollout = driver(batches)
    const coordinator = createAgentRolloutCoordinator(rollout)
    const { root, store } = fixture()
    const capture = () => captureRecoverySnapshot(store, { rootStore: root, sessionId: 's1', generation: 1 })

    await coordinator.capture(capture())
    await coordinator.capture(capture())
    store.setter(itemsAtom, [
      { id: 'b', createdAt: 2, item: { role: 'assistant', content: 'B' } },
      { id: 'a', createdAt: 1, item: { role: 'user', content: 'A2' } },
    ])
    await coordinator.capture(capture())
    store.setter(itemsAtom, [{ id: 'b', createdAt: 2, item: { role: 'assistant', content: 'B' } }])
    await coordinator.capture(capture())

    expect(batches).toHaveLength(3)
    expect(batches[0].map((entry) => entry.mutationType)).toEqual([
      'session_meta', 'turn_context', 'item_upsert', 'run_state',
    ])
    expect(batches[1].filter((entry) => entry.mutationType === 'item_upsert')).toHaveLength(2)
    expect(batches[2]).toContainEqual(expect.objectContaining({ mutationType: 'item_deleted', itemId: 'a' }))
  })

  it('does not advance previous when append rejects', async () => {
    const { root, store } = fixture()
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('rollout unavailable'))
      .mockResolvedValue({ records: [] })
    const coordinator = createAgentRolloutCoordinator({
      append, reconcile: async () => ({ histories: [] }), flush: async () => {},
    })
    const snapshot = captureRecoverySnapshot(store, { rootStore: root, sessionId: 's1', generation: 1 })

    await expect(coordinator.capture(snapshot)).rejects.toThrow('rollout unavailable')
    await coordinator.capture(snapshot)
    expect(append.mock.calls[1][1]).toHaveLength(4)
  })
})
