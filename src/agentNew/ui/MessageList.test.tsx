import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom } from '../state/sessionAtoms'
import { browserCardsAtom, type BrowserCard } from '../state/transientAtoms'
import type { ConversationItem } from '../state/core.type'
import { MessageList } from './MessageList'

// P-U3 / P8-g MessageList：读会话 store 的 itemsAtom + browserCardsAtom，
// 只渲染 user/有实质文本的 assistant（P3：null/纯空白 assistant 跳过空气泡）；
// system/tool 内部消息不渲染；browser 卡片与 items 按 createdAt 合并排序；空列表给占位。

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

  it('P3：content 为 null / 纯空白的 assistant 不渲染空气泡，有实质文本才渲染', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      // 纯工具调用轮：content=null，不该冒空气泡
      { id: 'a-null', createdAt: 0, item: { role: 'assistant', content: null } },
      // 全空白也视为空，不渲染
      { id: 'a-blank', createdAt: 1, item: { role: 'assistant', content: '   \n ' } },
      // 有实质文本，正常渲染
      { id: 'a-text', createdAt: 2, item: { role: 'assistant', content: '有内容' } },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    // 只剩一个 assistant 气泡（有文本那个）
    expect(container.querySelectorAll('.agentnew-msg--assistant')).toHaveLength(1)
    expect(screen.getByText('有内容')).toBeInTheDocument()
  })

  it('browser 卡片与 items 按 createdAt 合并排序渲染', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '问' } },
      { id: 'a1', createdAt: 3, item: { role: 'assistant', content: '答' } },
    ])
    const cards: BrowserCard[] = [{ id: 'c1', createdAt: 2, title: '卡A' }]
    store.setter(browserCardsAtom, cards)

    renderWithStore(<MessageList />, { store })

    const user = screen.getByText('问')
    const card = screen.getByText('卡A')
    const assistant = screen.getByText('答')

    // DOM 顺序：user(1) → 卡A(2) → assistant(3)
    // compareDocumentPosition(x) 含 FOLLOWING 位 ⇒ x 在参考节点之后
    expect(user.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('createdAt 相同用 id 字符串兜底稳定排序（R2）', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'b-item', createdAt: 5, item: { role: 'user', content: '条目B' } },
    ])
    const cards: BrowserCard[] = [{ id: 'a-card', createdAt: 5, title: '卡片A' }]
    store.setter(browserCardsAtom, cards)

    renderWithStore(<MessageList />, { store })

    const item = screen.getByText('条目B')
    const card = screen.getByText('卡片A')
    // 'a-card' < 'b-item' ⇒ 卡片在前、条目在后（确定顺序）
    expect(card.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 轮次 3 · TM1-4：GFM 表格 / 链接 target=_blank / raw HTML 转义安全回归。
  it('TM3：assistant 内容含 GFM 表格语法 → 渲染出 <table>（外包 .agentnew-md-table-wrap）', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-table',
        createdAt: 0,
        item: { role: 'assistant', content: '| a | b |\n| - | - |\n| 1 | 2 |' },
      },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    const table = screen.getByRole('table')
    expect(table).toBeInTheDocument()
    // 表格被包在 .agentnew-md-table-wrap 里（overflow-x:auto 防撑破气泡）
    expect(container.querySelector('.agentnew-md-table-wrap table')).toBe(table)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('TM3：assistant 内容含链接 → <a> 带 target=_blank 且 rel 含 noopener', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-link',
        createdAt: 0,
        item: { role: 'assistant', content: '[点击](https://example.com)' },
      },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    const link = screen.getByRole('link', { name: '点击' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('安全回归：assistant 内容含 <script>/<img onerror> → 不渲染为真实元素，以转义文本呈现', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-xss',
        createdAt: 0,
        item: {
          role: 'assistant',
          content: '注入测试：<script>alert(1)</script> 与 <img src=x onerror=alert(1)>',
        },
      },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    // 不存在真实的 script / img 元素
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // 原始标签以转义文本形式可见
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
