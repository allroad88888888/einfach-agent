import { render, screen } from '@testing-library/react'
import type { TimelineItem, TimelineMessageItem } from '@web-agent/core/timeline'
import { createTimelineRendererRegistry } from '@web-agent/react-plugin'
import { describe, expect, it } from 'vitest'
import { TimelineItemView } from './TimelineItemView'

const messageItem: TimelineMessageItem = {
  id: 'message:1',
  kind: 'message',
  createdAt: 0,
  sortKey: 'item:000000:message',
  conversationItem: {
    id: 'message-1',
    createdAt: 0,
    item: { role: 'user', content: 'hello' },
  },
}

function MessageRenderer({ item }: { readonly item: TimelineMessageItem }) {
  return <span>rendered:{item.id}</span>
}

describe('TimelineItemView', () => {
  it('uses the renderer resolved for the projected item kind', () => {
    const registry = createTimelineRendererRegistry({
      builtInRenderers: { message: MessageRenderer },
    })

    render(<TimelineItemView item={messageItem} registry={registry} />)

    expect(screen.getByText('rendered:message:1')).toBeInTheDocument()
  })

  it('uses the safe fallback when this root has no renderer for the item kind', () => {
    render(<TimelineItemView item={messageItem} registry={createTimelineRendererRegistry()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Unsupported timeline item: message')
  })

  it('keeps an unexpected runtime kind as text at the dispatcher boundary', () => {
    const unknownItem = {
      id: 'unknown:1',
      kind: '<img src=x onerror=alert(1)>',
    } as unknown as TimelineItem
    const { container } = render(
      <TimelineItemView item={unknownItem} registry={createTimelineRendererRegistry()} />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})
