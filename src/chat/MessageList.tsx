import { useEffect, useMemo, useRef } from 'react'
import { Markdown } from '@ai-components/markdown'
import { useAtomValue } from '@einfach/react'
import { activeBrowserCardsAtom, activeMessagesAtom, type BrowserCard } from '../agent/state/atoms'
import type { ChatMessage, ChatRole } from '../agent/runtime/types'
import { BrowserActionCard } from './BrowserActionCard'

type TranscriptItem =
  | { kind: 'message'; createdAt: number; seq: number; message: ChatMessage }
  | { kind: 'card'; createdAt: number; seq: number; card: BrowserCard }

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
  const cards = useAtomValue(activeBrowserCardsAtom)
  const endRef = useRef<HTMLDivElement>(null)

  // D4: render messages and browser cards as one chronological transcript stream,
  // merged by createdAt (cards are in-flow产物, not a fixed panel). BF5: tie-break
  // by the monotonic insertion `seq` (shared across both sources), so a card
  // lands at its true insertion position when createdAt collides — falling back
  // to array index for any legacy item that lacks a seq.
  const items = useMemo<TranscriptItem[]>(() => {
    const merged: TranscriptItem[] = [
      ...messages.map((message, index) => ({
        kind: 'message' as const,
        createdAt: message.createdAt,
        seq: message.seq ?? index,
        message,
      })),
      ...cards.map((card, index) => ({
        kind: 'card' as const,
        createdAt: card.createdAt,
        seq: card.seq ?? index,
        card,
      })),
    ]
    return merged
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          a.item.createdAt - b.item.createdAt || a.item.seq - b.item.seq || a.index - b.index,
      )
      .map((entry) => entry.item)
  }, [messages, cards])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [items])

  return (
    <section className="message-list chat-transcript agent-console-messages" aria-label="对话记录">
      <div className="message-list-inner chat-transcript-inner">
        {items.map((item) => {
          if (item.kind === 'card') {
            // BF7: prefix keys so a card id can never collide with a message id.
            return <BrowserActionCard key={`card:${item.card.id}`} card={item.card} />
          }
          const message = item.message
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
            <article key={`msg:${message.id}`} className={rowClassName}>
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
