// 右栏消息列表（P-U3 / P8-g）——在「当前会话 store」的 Provider 下，
// 读 itemsAtom + browserCardsAtom，把「可见消息」与「浏览器卡片」按时间合并渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：UI 只读 atom + 调命令，本组件只 useAtomValue 两个 atom（不 setter、不碰 store、不 import 命令）。
// 可见性规则：
//   · user：纯文本气泡，恒渲染；
//   · assistant：仅当 content 有实质文本才渲染；content 为 null 或 trim 为空（纯工具调用轮，
//     如 request_tool_schema）跳过，不冒空气泡（codex P3）；走 MessageMarkdown（react-markdown + GFM）。
//   · system / tool：发给/来自模型的内部条目，对用户不可见，跳过。
// browser 卡片（browserCardsAtom）与可见 items 按 createdAt 升序稳定合并；createdAt 相同时
//   用各自 id 字符串兜底，保证顺序确定、可测（R2）。
// 空状态：items 与 cards 都空时给「开始对话吧」占位。

import { useAtomValue } from '@einfach/react'
import { itemsAtom } from '../state/sessionAtoms'
import { browserCardsAtom, type BrowserCard } from '../state/transientAtoms'
import type { ConversationItem } from '../state/core.type'
import { BrowserActionCard } from './BrowserActionCard'
import { MessageMarkdown } from './MessageMarkdown'

// 合并渲染的条目：一条对话消息 或 一张浏览器卡片；统一带 createdAt + 稳定次级键 sortKey。
type MergedEntry =
  | { kind: 'item'; createdAt: number; sortKey: string; ci: ConversationItem }
  | { kind: 'card'; createdAt: number; sortKey: string; card: BrowserCard }

// 该对话条目是否对用户可见（见文件头可见性规则）。
function isVisibleItem(item: ConversationItem['item']): boolean {
  if (item.role === 'user') return true
  if (item.role === 'assistant') {
    return typeof item.content === 'string' && item.content.trim() !== ''
  }
  // system / tool：内部条目，不可见。
  return false
}

export function MessageList() {
  const items = useAtomValue(itemsAtom)
  const cards = useAtomValue(browserCardsAtom)

  // 空状态：items 与 cards 都空 → 占位（与既有行为一致）。
  if (items.length === 0 && cards.length === 0) {
    return <div className="agentnew-message-empty">开始对话吧</div>
  }

  // 可见 items 与 cards 合并，按 createdAt 升序；createdAt 相同用 id 字符串兜底稳定（R2）。
  const entries: MergedEntry[] = [
    ...items
      .filter((ci) => isVisibleItem(ci.item))
      .map<MergedEntry>((ci) => ({ kind: 'item', createdAt: ci.createdAt, sortKey: ci.id, ci })),
    ...cards.map<MergedEntry>((card) => ({
      kind: 'card',
      createdAt: card.createdAt,
      sortKey: card.id,
      card,
    })),
  ].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    if (a.sortKey < b.sortKey) return -1
    if (a.sortKey > b.sortKey) return 1
    return 0
  })

  return (
    <div className="agentnew-message-list">
      {entries.map((entry) => {
        if (entry.kind === 'card') {
          return <BrowserActionCard key={`card:${entry.card.id}`} card={entry.card} />
        }
        const { ci } = entry
        const { item } = ci
        if (item.role === 'user') {
          return (
            <div key={ci.id} className="agentnew-msg agentnew-msg--user">
              {item.content}
            </div>
          )
        }
        // 走到这里必是「有实质文本的 assistant」（isVisibleItem 已过滤 null/空白与 system/tool）。
        return (
          <div key={ci.id} className="agentnew-msg agentnew-msg--assistant">
            <MessageMarkdown>{item.content ?? ''}</MessageMarkdown>
          </div>
        )
      })}
    </div>
  )
}
