import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '../state/core.type'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCore } from './core/createCore'
import { currentTurnItems, currentTurnStartIndex } from './activeTurnItems'

function item(id: string, role: 'user' | 'assistant'): ConversationItem {
  return role === 'user'
    ? { id, createdAt: 1, item: { role, content: id } }
    : { id, createdAt: 1, item: { role, content: id } }
}

describe('currentTurnStartIndex', () => {
  it.each([
    ['uses the persisted turn anchor when it is present', [item('older-user', 'user'), item('turn-anchor', 'user'), item('reply', 'assistant')], 'turn-anchor', 1],
    ['falls back to the latest user item when the anchor is missing', [item('older-user', 'user'), item('newer-user', 'user'), item('reply', 'assistant')], 'missing-anchor', 1],
    ['starts at zero when there is no anchor or user item', [item('reply', 'assistant')], undefined, 0],
  ] as const)('%s', (_label, items, turnId, expected) => {
    expect(currentTurnStartIndex(items, turnId)).toBe(expected)
  })

  it('uses the shared boundary to project current turn items', () => {
    const core = createCore()
    const sessionId = core.newSession()
    const store = core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [item('older-user', 'user'), item('current-user', 'user'), item('reply', 'assistant')])
    store.setter(runAtom, { runId: 'run-1', status: 'interrupted', turnId: 'missing-anchor' })

    expect(currentTurnItems(sessionId, core).map((entry) => entry.id)).toEqual(['current-user', 'reply'])
  })
})
