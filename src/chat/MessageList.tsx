import { useEffect, useRef } from 'react'
import { Markdown } from '@ai-components/markdown'
import { useAtomValue } from '@einfach/react'
import { activeMessagesAtom } from '../agent/state/atoms'
import type { ChatRole } from '../agent/runtime/types'

const roleLabels: Record<ChatRole, string> = {
  user: '我',
  assistant: 'Agent',
  system: '系统',
}

const roleGlyphs: Record<ChatRole, string> = {
  user: '🧑',
  assistant: '🤖',
  system: '⚙️',
}

export function MessageList() {
  const messages = useAtomValue(activeMessagesAtom)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages])

  return (
    <section className="message-list chat-transcript agent-console-messages" aria-label="对话记录">
      <div className="message-list-inner chat-transcript-inner">
        {messages.map((message) => {
          const isStreaming = Boolean(message.streaming)
          const rowClassName = [
            'message-row',
            `message-${message.role}`,
            'chat-message',
            `chat-message--${message.role}`,
            isStreaming ? 'chat-message--streaming' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <article key={message.id} className={rowClassName}>
              <div className="message-avatar chat-message-avatar" aria-hidden="true">
                <span className="message-avatar-glyph">{roleGlyphs[message.role]}</span>
              </div>
              <div className="message-content chat-message-content">
                <div className="message-meta chat-message-meta">{roleLabels[message.role]}</div>
                <div className="message-bubble chat-message-bubble">
                  <div className="message-body chat-message-body">
                    <Markdown className="message-markdown chat-message-markdown">
                      {message.content || (message.streaming ? ' ' : '')}
                    </Markdown>
                    {isStreaming && <span className="stream-caret chat-message-stream-caret" />}
                  </div>
                </div>
              </div>
            </article>
          )
        })}
      </div>
      <div className="message-list-end chat-transcript-end" ref={endRef} />
    </section>
  )
}
