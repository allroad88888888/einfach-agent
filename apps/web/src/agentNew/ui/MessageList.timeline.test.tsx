import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, planAtom, browserCardsAtom, type BrowserCard } from '@einfach-agent/core'
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

    renderWithStore(<MessageList />, { agentStore: store })

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

    const { container } = renderWithStore(<MessageList />, { agentStore: store })

    expect(container.querySelector('.agentnew-message-empty')).toBeNull()
    expect(screen.getByText('条目B').closest('.agentnew-msg')).toHaveClass('agentnew-msg--user')
  })

  it('anchors a completed plan record after the create_plan turn', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '请执行优化' } },
      {
        id: 'a-plan', createdAt: 2,
        item: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'create-1', type: 'function', function: { name: 'create_plan', arguments: '{}' } }],
        },
      },
      { id: 't-plan', createdAt: 3, item: { role: 'tool', tool_call_id: 'create-1', content: '{"ok":true}' } },
      { id: 'a-final', createdAt: 4, item: { role: 'assistant', content: '后续答复' } },
    ])
    store.setter(planAtom, {
      id: 'plan-1', title: '优化计划', objective: '完成优化', status: 'completed', revision: 1,
      requiresApproval: false, createdAt: 3, updatedAt: 4, stages: [],
    })

    renderWithStore(<MessageList />, { agentStore: store })

    const creation = screen.getByText('工具 create_plan').closest('.agentnew-tool-execution-group')
    const record = screen.getByText('计划记录').closest('.agentnew-plan')
    const finalReply = screen.getByText('后续答复').closest('.agentnew-msg')
    expect(creation).not.toBeNull()
    expect(record).not.toBeNull()
    expect(finalReply).not.toBeNull()
    if (!creation || !record || !finalReply) throw new Error('expected creation, record, and final reply')
    expect(creation.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(record.compareDocumentPosition(finalReply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
