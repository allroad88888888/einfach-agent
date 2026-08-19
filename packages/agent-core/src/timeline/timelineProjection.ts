import type { ModelToolCall, ToolItem } from '@einfach-agent/ai'
import type { ConversationItem } from '../state/core.type'
import type { BrowserCard, RuntimeTranscriptEvent } from '../state/transientAtoms'

export interface TimelineItemBase {
  readonly id: string
  readonly createdAt: number
  readonly sortKey: string
  /** 来源会话条目的计划阶段；非会话项没有该值。 */
  readonly planStageId?: string
}

export interface TimelineMessageItem extends TimelineItemBase {
  readonly kind: 'message'
  readonly conversationItem: ConversationItem
}

export interface TimelineReasoningItem extends TimelineItemBase {
  readonly kind: 'reasoning'
  readonly content: string
}

export interface TimelineThinkingMessageItem extends TimelineItemBase {
  readonly kind: 'thinking-message'
  readonly conversationItem: ConversationItem
}

export interface TimelineToolExecution {
  readonly call?: ModelToolCall
  readonly result?: ToolItem
  /** 仅孤立 tool result 使用，保留其 tool_call_id 以便宿主展示。 */
  readonly toolName?: string
}

export interface TimelineToolExecutionItem extends TimelineItemBase {
  readonly kind: 'tool-execution-group'
  readonly executions: readonly TimelineToolExecution[]
}

export interface TimelineRuntimeEventItem extends TimelineItemBase {
  readonly kind: 'runtime-event'
  readonly event: RuntimeTranscriptEvent
}

export interface TimelineBrowserCardItem extends TimelineItemBase {
  readonly kind: 'card'
  readonly card: BrowserCard
}

export type TimelineItem =
  | TimelineMessageItem
  | TimelineReasoningItem
  | TimelineThinkingMessageItem
  | TimelineToolExecutionItem
  | TimelineRuntimeEventItem
  | TimelineBrowserCardItem

export type TimelineThinkingItem = Extract<
  TimelineItem,
  { kind: 'reasoning' | 'thinking-message' | 'tool-execution-group' | 'runtime-event' }
>

export interface TimelineProjectionInput {
  readonly conversationItems: readonly ConversationItem[]
  readonly runtimeEvents?: readonly RuntimeTranscriptEvent[]
  readonly browserCards?: readonly BrowserCard[]
  /** 用于把流式占位项接到历史消息之后，默认从零开始。 */
  readonly conversationItemIndexOffset?: number
}

interface ToolExecutionIndex {
  readonly calls: ReadonlyMap<string, ModelToolCall>
  readonly results: ReadonlyMap<string, ToolItem>
}

function buildToolExecutionIndex(items: readonly ConversationItem[]): ToolExecutionIndex {
  const calls = new Map<string, ModelToolCall>()
  const results = new Map<string, ToolItem>()
  for (const { item } of items) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) calls.set(call.id, call)
    } else if (item.role === 'tool') {
      results.set(item.tool_call_id, item)
    }
  }
  return { calls, results }
}

function conversationItemEntries(
  conversationItem: ConversationItem,
  itemIndex: number,
  toolExecutionIndex: ToolExecutionIndex,
): TimelineItem[] {
  const baseKey = `item:${String(itemIndex).padStart(6, '0')}:${conversationItem.id}`
  const base = {
    createdAt: conversationItem.createdAt,
    planStageId: conversationItem.planStageId,
  }
  const item = conversationItem.item
  if (item.role === 'user') {
    return [{
      ...base,
      id: `${conversationItem.id}:message`,
      kind: 'message',
      sortKey: `${baseKey}:message`,
      conversationItem,
    }]
  }

  if (item.role === 'assistant') {
    const entries: TimelineItem[] = []
    if (typeof item.reasoning_content === 'string' && item.reasoning_content.trim() !== '') {
      entries.push({
        ...base,
        id: `${conversationItem.id}:reasoning`,
        kind: 'reasoning',
        sortKey: `${baseKey}:00-reasoning`,
        content: item.reasoning_content,
      })
    }
    if (typeof item.content === 'string' && item.content.trim() !== '') {
      entries.push({
        ...base,
        id: `${conversationItem.id}:message`,
        kind: item.tool_calls?.length ? 'thinking-message' : 'message',
        sortKey: `${baseKey}:01-message`,
        conversationItem,
      })
    }
    if (item.tool_calls?.length) {
      entries.push({
        ...base,
        id: `${conversationItem.id}:tool-execution-group`,
        kind: 'tool-execution-group',
        sortKey: `${baseKey}:02-tool-execution-group`,
        executions: item.tool_calls.map((call) => ({
          call,
          result: toolExecutionIndex.results.get(call.id),
        })),
      })
    }
    return entries
  }

  if (item.role === 'tool' && !toolExecutionIndex.calls.has(item.tool_call_id)) {
    return [{
      ...base,
      id: `${conversationItem.id}:tool-execution-group`,
      kind: 'tool-execution-group',
      sortKey: `${baseKey}:tool-execution-group`,
      executions: [{ result: item, toolName: item.tool_call_id }],
    }]
  }

  // system 项目不进入用户可见时间线；正常 system 注入由 runtime event 承载。
  return []
}

function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.sortKey.localeCompare(b.sortKey)
}

export function isTimelineThinkingItem(item: TimelineItem): item is TimelineThinkingItem {
  return item.kind === 'reasoning' ||
    item.kind === 'thinking-message' ||
    item.kind === 'tool-execution-group' ||
    item.kind === 'runtime-event'
}

/**
 * 投影现有 Core 会话与瞬态显示数据。函数不改写输入，且同一输入保持稳定的排序与 key。
 */
export function projectTimelineItems(input: TimelineProjectionInput): TimelineItem[] {
  const itemOffset = input.conversationItemIndexOffset ?? 0
  const toolExecutionIndex = buildToolExecutionIndex(input.conversationItems)
  const conversationEntries = input.conversationItems.flatMap((conversationItem, index) => (
    conversationItemEntries(conversationItem, itemOffset + index, toolExecutionIndex)
  ))
  const runtimeEntries: TimelineRuntimeEventItem[] = (input.runtimeEvents ?? []).map((event, index) => ({
    id: `runtime:${event.id}`,
    kind: 'runtime-event',
    createdAt: event.createdAt,
    sortKey: `runtime:${String(index).padStart(6, '0')}:${event.id}`,
    event,
  }))
  const cardEntries: TimelineBrowserCardItem[] = (input.browserCards ?? []).map((card) => ({
    id: `card:${card.id}`,
    kind: 'card',
    createdAt: card.createdAt,
    sortKey: `card:${card.id}`,
    card,
  }))

  return [...conversationEntries, ...runtimeEntries, ...cardEntries].sort(compareTimelineItems)
}

/**
 * 按计划阶段投影其思考与工具记录；assistant 正文在该视图中是执行说明而不是最终答复。
 */
export function projectPlanStageTimelineItems(
  conversationItems: readonly ConversationItem[],
): Map<string, TimelineThinkingItem[]> {
  const entriesByStage = new Map<string, TimelineThinkingItem[]>()
  const toolExecutionIndex = buildToolExecutionIndex(conversationItems)
  conversationItems.forEach((conversationItem, index) => {
    const stageId = conversationItem.planStageId
    if (!stageId) return
    const entries = conversationItemEntries(conversationItem, index, toolExecutionIndex)
      .map((entry): TimelineItem => (
        entry.kind === 'message' && entry.conversationItem.item.role === 'assistant'
          ? { ...entry, kind: 'thinking-message' }
          : entry
      ))
      .filter(isTimelineThinkingItem)
    if (entries.length === 0) return
    const current = entriesByStage.get(stageId) ?? []
    current.push(...entries)
    entriesByStage.set(stageId, current)
  })
  for (const entries of entriesByStage.values()) entries.sort(compareTimelineItems)
  return entriesByStage
}
