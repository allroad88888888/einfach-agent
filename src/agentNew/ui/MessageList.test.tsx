import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom } from '../state/sessionAtoms'
import type { ConversationItem } from '../state/core.type'
import { MessageList } from './MessageList'

// P-U3 MessageList：读会话 store 的 itemsAtom，只渲染 user/assistant；
// assistant 走 react-markdown；system/tool 是内部消息不渲染；空列表给占位。

describe('MessageList', () => {
  it('渲染 user 纯文本 + assistant markdown，跳过 system/tool', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      { id: 'u1', createdAt: 0, item: { role: 'user', content: '你好' } },
      { id: 'a1', createdAt: 1, item: { role: 'assistant', content: '**回复**' } },
      { id: 's1', createdAt: 2, item: { role: 'system', content: '系统' } },
      { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'x', content: '工具' } },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    // user 纯文本在
    expect(screen.getByText('你好')).toBeInTheDocument()
    // assistant 的 markdown 被渲染：**回复** → <strong>回复</strong>
    const strong = screen.getByText('回复')
    expect(strong).toBeInTheDocument()
    expect(strong.tagName).toBe('STRONG')
    // system / tool 内部消息不渲染
    expect(screen.queryByText('系统')).toBeNull()
    expect(screen.queryByText('工具')).toBeNull()
  })

  it('空列表渲染占位', () => {
    const store = createStore()
    store.setter(itemsAtom, [])

    const { container } = renderWithStore(<MessageList />, { store })

    expect(container.querySelector('.agentnew-message-empty')).not.toBeNull()
    expect(screen.getByText('开始对话吧')).toBeInTheDocument()
  })
})
