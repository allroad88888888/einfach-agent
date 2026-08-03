import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom } from '@web-agent/core/state/sessionAtoms'
import { browserCardsAtom, type BrowserCard } from '@web-agent/core/state/transientAtoms'
import { MessageList } from './MessageList'

/** Covers MessageList ordering and empty-state behavior for timeline rows. */
describe('MessageList timeline rows', () => {
  it('orders browser cards between messages by createdAt', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '问' } },
      { id: 'a1', createdAt: 3, item: { role: 'assistant', content: '答' } },
    ])
    const cards: BrowserCard[] = [{ id: 'c1', createdAt: 2, title: '卡A' }]
    store.setter(browserCardsAtom, cards)

    renderWithStore(<MessageList />, { store })

    expect(screen.getByText('问').closest('.agentnew-msg')).toHaveClass('agentnew-msg--user')
    const card = screen.getByText('卡A')
    const assistant = screen.getByText('答')
    expect(card.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders user-only timelines without an empty-state placeholder', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'b-item', createdAt: 5, item: { role: 'user', content: '条目B' } },
    ])

    const { container } = renderWithStore(<MessageList />, { store })

    expect(container.querySelector('.agentnew-message-empty')).toBeNull()
    expect(screen.getByText('条目B').closest('.agentnew-msg')).toHaveClass('agentnew-msg--user')
  })
})
