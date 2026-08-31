// Core message timeline item 的默认 Web 呈现；回退按钮由列表 shell 组合。

import type { TimelineMessageItem } from '@einfach-agent/core/timeline'
import { userMessageText, type UserImageContentBlock } from '@einfach-agent/ai'
import { useLingui } from '@lingui/react/macro'
import { MessageMarkdown } from './MessageMarkdown'
import { UserImageAttachmentCard } from './UserImageAttachmentCard'

export function MessageTimelineRenderer({ item }: { readonly item: TimelineMessageItem }) {
  const { t } = useLingui()
  const conversationItem = item.conversationItem
  const isUser = conversationItem.item.role === 'user'
  const isStreaming = conversationItem.pending === true
  const className = [
    'agentnew-msg',
    isUser ? 'agentnew-msg--user' : 'agentnew-msg--assistant',
    isStreaming ? 'agentnew-msg--streaming' : '',
  ].filter(Boolean).join(' ')
  const userContent = isUser ? conversationItem.item.content : undefined
  const content = conversationItem.item.role === 'assistant'
    ? conversationItem.item.content ?? ''
    : userContent == null ? '' : userMessageText(userContent)
  const images: readonly UserImageContentBlock[] = isUser && Array.isArray(userContent)
    ? userContent.filter((block): block is UserImageContentBlock => block.type === 'image')
    : []

  return (
    <div className={className}>
      {content ? <MessageMarkdown>{content}</MessageMarkdown> : null}
      {images.map((image, index) => <UserImageAttachmentCard key={`${image.name}-${index}`} image={image} />)}
      {isStreaming ? <span className="agentnew-stream-caret" aria-label={t`正在生成`} /> : null}
    </div>
  )
}
