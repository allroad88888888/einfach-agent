// 右栏消息列表（P-U3 / P8-g）——在「当前会话 store」的 Provider 下，
// 读 itemsAtom + browserCardsAtom + runtimeTranscriptEventsAtom，把助手回复、工具调用/结果、
// 运行时注入事件与浏览器卡片按时间合并渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：UI 只读 atom + 调命令，本组件只 useAtomValue，不 setter、不碰 store、不 import 命令。
// 可见性规则：
//   · user：不渲染，避免把输入内容在 transcript 里重复列一遍；它仍保留在 itemsAtom 供模型上下文使用；
//   · assistant：content 有实质文本时渲染文本气泡；tool_calls 始终渲染为调试行；
//   · tool：作为工具结果调试行渲染；
//   · runtime transcript event：展示 system/tools 等不该入 ModelItem 历史的注入；
//   · system ConversationItem：仍然不渲染，避免把异常入库的 system 当成正常 transcript。

import { useAtomValue } from '@einfach/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { itemsAtom } from '@web-agent/core/state/sessionAtoms'
import {
  browserCardsAtom,
  runtimeTranscriptEventsAtom,
  type BrowserCard,
  type RuntimeTranscriptEvent,
} from '@web-agent/core/state/transientAtoms'
import type { ConversationItem } from '@web-agent/core/state/core.type'
import type { ModelToolCall, ToolItem } from '@web-agent/ai'
import { BrowserActionCard } from './BrowserActionCard'
import { MessageMarkdown } from './MessageMarkdown'

const BOTTOM_STICKY_THRESHOLD = 48
const DETAIL_MAX_CHARS = 20_000

// 合并渲染的条目：对话消息、工具调试行、runtime 注入事件或浏览器卡片。
type MergedEntry =
  | { kind: 'message'; createdAt: number; sortKey: string; ci: ConversationItem }
  | { kind: 'tool-call'; createdAt: number; sortKey: string; call: ModelToolCall }
  | {
      kind: 'tool-result'
      createdAt: number
      sortKey: string
      item: ToolItem
      toolName?: string
    }
  | { kind: 'runtime-event'; createdAt: number; sortKey: string; event: RuntimeTranscriptEvent }
  | { kind: 'card'; createdAt: number; sortKey: string; card: BrowserCard }

function compactText(value: string, limit = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact
}

function limitedDetail(value: string): string {
  if (value.length <= DETAIL_MAX_CHARS) return value
  return `${value.slice(0, DETAIL_MAX_CHARS)}\n... 已截断 ${value.length - DETAIL_MAX_CHARS} 个字符`
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonDetail(raw: string): string {
  const parsed = parseJson(raw)
  if (parsed === undefined) return raw || '{}'
  return JSON.stringify(parsed, null, 2)
}

function argValueSummary(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function toolCallSummary(call: ModelToolCall): string {
  const parsed = parseJson(call.function.arguments)
  if (isRecord(parsed)) {
    for (const key of ['toolName', 'name', 'query', 'path', 'command', 'reason']) {
      const value = argValueSummary(parsed[key])
      if (value) return compactText(`${key}=${value}`, 180)
    }
  }
  return compactText(jsonDetail(call.function.arguments), 180)
}

function toolResultSummary(content: string): string {
  const parsed = parseJson(content)
  if (isRecord(parsed)) {
    const error = argValueSummary(parsed.error)
    if (error) return compactText(`error=${error}`, 180)
    const ok = argValueSummary(parsed.ok)
    if (ok) return compactText(`ok=${ok}`, 180)
  }
  return compactText(content, 180)
}

function buildToolNameByCallId(items: ConversationItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const { item } of items) {
    if (item.role !== 'assistant') continue
    for (const call of item.tool_calls ?? []) {
      map.set(call.id, call.function.name)
    }
  }
  return map
}

function itemEntries(
  ci: ConversationItem,
  itemIndex: number,
  toolNameByCallId: Map<string, string>,
): MergedEntry[] {
  const baseKey = `item:${String(itemIndex).padStart(6, '0')}:${ci.id}`
  const item = ci.item
  if (item.role === 'user') {
    return []
  }

  if (item.role === 'assistant') {
    const entries: MergedEntry[] = []
    if (typeof item.content === 'string' && item.content.trim() !== '') {
      entries.push({ kind: 'message', createdAt: ci.createdAt, sortKey: `${baseKey}:message`, ci })
    }
    item.tool_calls?.forEach((call, callIndex) => {
      entries.push({
        kind: 'tool-call',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:tool-call:${String(callIndex).padStart(3, '0')}`,
        call,
      })
    })
    return entries
  }

  if (item.role === 'tool') {
    return [
      {
        kind: 'tool-result',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:tool-result`,
        item,
        toolName: toolNameByCallId.get(item.tool_call_id),
      },
    ]
  }

  // system ConversationItem 不展示；正常 system 注入通过 runtime transcript event 展示。
  return []
}

function DebugEntry({
  variant,
  label,
  title,
  summary,
  detail,
}: {
  variant: 'tool-call' | 'tool-result' | 'injection'
  label: string
  title: string
  summary?: string
  detail?: string
}) {
  const className = `agentnew-debug-entry agentnew-debug-entry--${variant}`
  return (
    <div className={className}>
      <div className="agentnew-debug-head">
        <span className="agentnew-debug-label">{label}</span>
        <span className="agentnew-debug-title">{title}</span>
      </div>
      {summary ? <div className="agentnew-debug-summary">{summary}</div> : null}
      {detail ? (
        <details className="agentnew-debug-details">
          <summary>详情</summary>
          <pre>{limitedDetail(detail)}</pre>
        </details>
      ) : null}
    </div>
  )
}

export function MessageList() {
  const items = useAtomValue(itemsAtom)
  const cards = useAtomValue(browserCardsAtom)
  const runtimeEvents = useAtomValue(runtimeTranscriptEventsAtom)
  const listRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)

  const entries = useMemo<MergedEntry[]>(() => {
    const toolNameByCallId = buildToolNameByCallId(items)
    return [
      ...items.flatMap((ci, index) => itemEntries(ci, index, toolNameByCallId)),
      ...runtimeEvents.map<MergedEntry>((event, index) => ({
        kind: 'runtime-event',
        createdAt: event.createdAt,
        sortKey: `runtime:${String(index).padStart(6, '0')}:${event.id}`,
        event,
      })),
      ...cards.map<MergedEntry>((card) => ({
        kind: 'card',
        createdAt: card.createdAt,
        sortKey: `card:${card.id}`,
        card,
      })),
    ].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a.sortKey < b.sortKey) return -1
      if (a.sortKey > b.sortKey) return 1
      return 0
    })
  }, [cards, items, runtimeEvents])

  const scrollSignature = entries
    .map((entry) => {
      if (entry.kind === 'card') return `card:${entry.card.id}:${entry.card.title}:${entry.card.body ?? ''}`
      if (entry.kind === 'runtime-event') {
        return `runtime:${entry.event.id}:${entry.event.summary ?? ''}:${entry.event.detail ?? ''}`
      }
      if (entry.kind === 'tool-call') {
        return `tool-call:${entry.call.id}:${entry.call.function.name}:${entry.call.function.arguments}`
      }
      if (entry.kind === 'tool-result') {
        return `tool-result:${entry.item.tool_call_id}:${entry.toolName ?? ''}:${entry.item.content}`
      }
      const { ci } = entry
      const content = ci.item.role === 'assistant' ? ci.item.content : ''
      return `item:${ci.id}:${ci.pending ? 'pending' : 'done'}:${content ?? ''}`
    })
    .join('|')

  useEffect(() => {
    const node = listRef.current
    if (!node) return

    const updateStickiness = () => {
      const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      shouldStickToBottomRef.current = distanceToBottom <= BOTTOM_STICKY_THRESHOLD
    }

    updateStickiness()
    node.addEventListener('scroll', updateStickiness, { passive: true })
    return () => node.removeEventListener('scroll', updateStickiness)
  }, [entries.length])

  useLayoutEffect(() => {
    const node = listRef.current
    if (!node || !shouldStickToBottomRef.current) return
    node.scrollTop = node.scrollHeight
  }, [scrollSignature])

  if (entries.length === 0) {
    return <div className="agentnew-message-empty">开始对话吧</div>
  }

  return (
    <div ref={listRef} className="agentnew-message-list">
      {entries.map((entry) => {
        if (entry.kind === 'card') {
          return <BrowserActionCard key={`card:${entry.card.id}`} card={entry.card} />
        }
        if (entry.kind === 'runtime-event') {
          return (
            <DebugEntry
              key={`runtime:${entry.event.id}`}
              variant="injection"
              label="注入"
              title={entry.event.title}
              summary={entry.event.summary}
              detail={entry.event.detail}
            />
          )
        }
        if (entry.kind === 'tool-call') {
          const title = `调用工具 ${entry.call.function.name}`
          return (
            <DebugEntry
              key={`tool-call:${entry.call.id}`}
              variant="tool-call"
              label="调用"
              title={title}
              summary={toolCallSummary(entry.call)}
              detail={jsonDetail(entry.call.function.arguments)}
            />
          )
        }
        if (entry.kind === 'tool-result') {
          const title = `工具结果 ${entry.toolName ?? entry.item.tool_call_id}`
          return (
            <DebugEntry
              key={`tool-result:${entry.item.tool_call_id}:${entry.sortKey}`}
              variant="tool-result"
              label="结果"
              title={title}
              summary={toolResultSummary(entry.item.content)}
              detail={jsonDetail(entry.item.content)}
            />
          )
        }

        const { ci } = entry
        const { item } = ci
        const isStreaming = ci.pending === true
        const className = isStreaming
          ? 'agentnew-msg agentnew-msg--assistant agentnew-msg--streaming'
          : 'agentnew-msg agentnew-msg--assistant'
        return (
          <div key={ci.id} className={className}>
            <MessageMarkdown>{item.role === 'assistant' ? item.content ?? '' : ''}</MessageMarkdown>
            {isStreaming ? <span className="agentnew-stream-caret" aria-label="正在生成" /> : null}
          </div>
        )
      })}
    </div>
  )
}
