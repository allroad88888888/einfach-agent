import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, type ConversationItem } from '@web-agent/core'
import { MessageList } from './MessageList'

function renderAssistantMessage(content: string) {
  const store = createStore()
  const items: ConversationItem[] = [{
    id: 'assistant-message',
    createdAt: 0,
    item: { role: 'assistant', content },
  }]
  store.setter(itemsAtom, items)
  return renderWithStore(<MessageList />, { store })
}

/** Covers the deferred GFM renderer used by MessageList assistant rows. */
describe('MessageList Markdown', () => {
  it('renders GFM tables inside the overflow wrapper', async () => {
    const { container } = renderAssistantMessage('| a | b |\n| - | - |\n| 1 | 2 |')

    const table = await screen.findByRole('table')
    expect(table).toBeInTheDocument()
    expect(container.querySelector('.agentnew-md-table-wrap table')).toBe(table)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('renders external links with the hardened browser attributes', async () => {
    renderAssistantMessage('[点击](https://example.com)')

    const link = await screen.findByRole('link', { name: '点击' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('keeps raw script and image markup as escaped text', async () => {
    const { container } = renderAssistantMessage(
      '注入测试：<script>alert(1)</script> 与 <img src=x onerror=alert(1)>',
    )

    await waitFor(() => expect(container.querySelector('.agentnew-msg p')).not.toBeNull())
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
