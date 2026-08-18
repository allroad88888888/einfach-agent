import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, type ConversationItem } from '@web-agent/core'
import { MessageList } from './MessageList'
import {
  MESSAGE_WINDOW_SIZE,
  MESSAGE_WINDOW_STEP,
  messageWindowAtom,
} from './messageWindowModel'

function longConversation(): ConversationItem[] {
  return Array.from({ length: 500 }, (_, index): ConversationItem => ({
    id: `message-${index}`,
    createdAt: index,
    item: { role: 'assistant', content: `第 ${index + 1} 条消息` },
  }))
}

/** Covers the bounded DOM window used for long conversation timelines. */
describe('MessageList windowing', () => {
  it('mounts only the latest window without a total-height placeholder', () => {
    const store = createStore()
    store.setter(itemsAtom, longConversation())

    const { container } = renderWithStore(<MessageList />, { agentStore: store })

    const mountedRows = container.querySelectorAll('.agentnew-window-row')
    expect(container.querySelector('.agentnew-virtual-sizer')).toBeNull()
    expect(mountedRows).toHaveLength(80)
    expect(screen.getByText('第 500 条消息')).toBeInTheDocument()
    expect(screen.queryByText('第 1 条消息')).toBeNull()
  })

  it('moves the window toward history at its top while preserving mount count', () => {
    const store = createStore()
    store.setter(itemsAtom, longConversation())

    // 滑动窗口是渲染态，住 UI store —— 会话内容在 agentStore，两者刻意不是同一个。
    const { container, store: uiStore } = renderWithStore(<MessageList />, { agentStore: store })
    const list = container.querySelector<HTMLElement>('.agentnew-message-list')
    expect(list).not.toBeNull()
    Object.defineProperties(list!, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4_000 },
    })
    list!.scrollTop = 0
    fireEvent.scroll(list!)

    expect(uiStore.getter(messageWindowAtom)).toMatchObject({
      start: 500 - MESSAGE_WINDOW_SIZE - MESSAGE_WINDOW_STEP,
      end: 500 - MESSAGE_WINDOW_STEP,
      direction: 'backward',
    })
    expect(container.querySelectorAll('.agentnew-window-row')).toHaveLength(MESSAGE_WINDOW_SIZE)
    expect(screen.getByText('第 397 条消息')).toBeInTheDocument()
    expect(screen.queryByText('第 500 条消息')).toBeNull()
  })
})
