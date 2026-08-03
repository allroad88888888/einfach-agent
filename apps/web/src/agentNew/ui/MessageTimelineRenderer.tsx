// Core message timeline item 的默认 Web 呈现；回退按钮由列表 shell 组合。

import type { TimelineMessageItem } from '@web-agent/core/timeline'
import { MessageMarkdown } from './MessageMarkdown'

export function MessageTimelineRenderer({ item }: { readonly item: TimelineMessageItem }) {
  const conversationItem = item.conversationItem
  const isUser = conversationItem.item.role === 'user'
  const isStreaming = conversationItem.pending === true
  const className = [
    'agentnew-msg',
    isUser ? 'agentnew-msg--user' : 'agentnew-msg--assistant',
    isStreaming ? 'agentnew-msg--streaming' : '',
  ].filter(Boolean).join(' ')
  const content = conversationItem.item.role === 'assistant' || conversationItem.item.role === 'user'
    ? conversationItem.item.content ?? ''
    : ''

  return (
    <div className={className}>
      <MessageMarkdown>{content}</MessageMarkdown>
      {isStreaming ? <span className="agentnew-stream-caret" aria-label="正在生成" /> : null}
    </div>
  )
}
