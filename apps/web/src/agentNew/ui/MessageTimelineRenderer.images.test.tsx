import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { TimelineMessageItem } from '@web-agent/core/timeline'
import { renderWithStore } from '../../test/renderWithStore'
import { MessageTimelineRenderer } from './MessageTimelineRenderer'
import { HistoryImageCompatibilityProvider } from './HistoryImageCompatibilityContext'

const item: TimelineMessageItem = {
  id: 'u1',
  createdAt: 1,
  sortKey: '1',
  kind: 'message',
  conversationItem: {
    id: 'u1',
    createdAt: 1,
    item: {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        {
          type: 'image',
          name: 'diagram.png',
          mimeType: 'image/png',
          byteSize: 1024,
          source: { kind: 'provider-file', provider: 'kimi', scope: 'kimi:cn', reference: 'ms://secret-ref' },
        },
      ],
    },
  },
}

describe('MessageTimelineRenderer image history', () => {
  it('显示用户文本和可恢复的图片元数据，但不泄露 provider 引用', () => {
    renderWithStore(
      <HistoryImageCompatibilityProvider vendor="kimi" model="kimi-k2.6" region="cn">
        <MessageTimelineRenderer item={item} />
      </HistoryImageCompatibilityProvider>,
    )

    expect(screen.getByText('看看这张图')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '已发送图片：diagram.png' })).toHaveTextContent('image/png · 0.0 MB')
    expect(screen.queryByText('ms://secret-ref')).toBeNull()
  })

  it('为不兼容模型显示确定性占位，且不泄露 provider、scope 或 reference', () => {
    const { container } = renderWithStore(
      <HistoryImageCompatibilityProvider vendor="deepseek" model="deepseek-chat">
        <MessageTimelineRenderer item={item} />
      </HistoryImageCompatibilityProvider>,
    )

    expect(screen.getByRole('group', { name: '历史图片不可用：diagram.png' }))
      .toHaveTextContent('当前模型无法使用这张历史图片')
    expect(container).not.toHaveTextContent('kimi')
    expect(container).not.toHaveTextContent('kimi:cn')
    expect(container).not.toHaveTextContent('ms://secret-ref')
  })
})
