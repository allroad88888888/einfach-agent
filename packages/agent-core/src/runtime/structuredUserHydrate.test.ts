import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UserMessageContent } from '@web-agent/ai'
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionMeta } from '../state/core.type'
import { resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { checkpointsAtom, itemsAtom } from '../state/sessionAtoms'
import { hydrate } from '../state/persistence/hydrate'
import { createMemoryHistoryDriver } from '../state/persistence/memoryHistoryDriver'

const structuredContent: UserMessageContent = [
  { type: 'text', text: 'hydrate this image' },
  {
    type: 'image',
    source: {
      kind: 'provider-file',
      provider: 'opaque-provider',
      scope: 'opaque-scope',
      reference: 'opaque-reference',
    },
    name: 'hydrated.png',
    mimeType: 'image/png',
    byteSize: 23,
  },
]

function resetState(): void {
  resetRootStore()
  resetSessionStores()
}

beforeEach(resetState)
afterEach(resetState)

describe('structured user content hydration', () => {
  it('restores structured checkpoint content without promoting it to live recovery state', async () => {
    const session: SessionMeta = {
      id: 'structured-hydrate',
      title: 'structured',
      settings: { vendor: 'deepseek', model: 'test-model' },
      createdAt: 1,
      updatedAt: 1,
    }
    const checkpoint: Checkpoint = {
      turnIndex: 0,
      label: 'structured',
      kind: 'working',
      createdAt: 2,
      items: [{
        id: 'user-image',
        createdAt: 1,
        item: { role: 'user', content: structuredContent },
      }],
    }
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint(session.id, checkpoint)

    await expect(hydrate({
      sessions: { loadSessions: async () => [session] },
      history,
    })).resolves.toBe(true)

    const store = getSessionStore(session.id).store
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(checkpointsAtom)[0].items[0].item).toEqual({
      role: 'user',
      content: structuredContent,
    })
  })
})
