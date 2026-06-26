import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeBrowserCardsAtom,
  addBrowserCard,
  browserCardsBySessionAtom,
  createSession,
  deleteSession,
} from './atoms'

// browser_action: BrowserCard atom + addBrowserCard ghost guard + deleteSession cleanup.
describe('browserCardsBySessionAtom / addBrowserCard', () => {
  it('inserts a card and returns ok + cardId; active atom reflects it', () => {
    const store = createStore()
    const sessionId = createSession(store, 'card session')

    const result = addBrowserCard(store, sessionId, {
      id: 'card-1',
      createdAt: 1000,
      title: '标题',
      body: '正文',
      items: ['a', 'b'],
      options: ['x', 'y'],
    })

    expect(result).toEqual({ ok: true, cardId: 'card-1' })
    const cards = store.getter(browserCardsBySessionAtom)[sessionId]
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: 'card-1', title: '标题' })
    expect(store.getter(activeBrowserCardsAtom)).toHaveLength(1)
  })

  it('ghost guard: returns {ok:false} and writes nothing when the session is gone', () => {
    const store = createStore()
    const result = addBrowserCard(store, 'missing-session', {
      id: 'card-x',
      createdAt: 1,
      title: 'ghost',
    })
    expect(result).toEqual({ ok: false })
    expect(store.getter(browserCardsBySessionAtom)['missing-session']).toBeUndefined()
  })

  it('deleteSession clears the session browser cards', () => {
    const store = createStore()
    const sessionId = createSession(store, 'to delete')
    addBrowserCard(store, sessionId, { id: 'c', createdAt: 1, title: 't' })
    expect(store.getter(browserCardsBySessionAtom)[sessionId]).toHaveLength(1)

    deleteSession(store, sessionId)
    expect(store.getter(browserCardsBySessionAtom)[sessionId]).toBeUndefined()
  })
})
