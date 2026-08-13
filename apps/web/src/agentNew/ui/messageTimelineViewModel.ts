// 消息列表的思考分组与虚拟行视图模型。

import {
  isTimelineThinkingItem,
  type TimelineItem,
  type TimelineThinkingItem,
} from '@web-agent/core/timeline'
import type { PlanSnapshot } from '@web-agent/core/planning'

export interface CompletedPlanRecordEntry {
  kind: 'completed-plan-record'
  createdAt: number
  sortKey: string
}

export type TimelineRenderEntry =
  | Exclude<TimelineItem, TimelineThinkingItem>
  | CompletedPlanRecordEntry
  | {
      kind: 'thinking-group'
      createdAt: number
      sortKey: string
      entries: TimelineThinkingItem[]
    }

export type TimelineVirtualEntry =
  | Exclude<TimelineRenderEntry, { kind: 'thinking-group' }>
  | {
      kind: 'thinking-header'
      createdAt: number
      sortKey: string
      group: Extract<TimelineRenderEntry, { kind: 'thinking-group' }>
    }
  | {
      kind: 'thinking-step-row'
      createdAt: number
      sortKey: string
      entry: TimelineThinkingItem
    }

export function groupTimelineThinkingEntries(entries: TimelineItem[]): TimelineRenderEntry[] {
  const grouped: TimelineRenderEntry[] = []
  for (const entry of entries) {
    if (!isTimelineThinkingItem(entry)) {
      grouped.push(entry)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'thinking-group') previous.entries.push(entry)
    else {
      grouped.push({
        kind: 'thinking-group',
        createdAt: entry.createdAt,
        sortKey: `thinking:${entry.sortKey}`,
        entries: [entry],
      })
    }
  }
  return grouped
}

function createsPlan(entry: TimelineRenderEntry): boolean {
  const thinkingEntries = entry.kind === 'thinking-group' ? entry.entries : [entry]
  return thinkingEntries.some((thinkingEntry) => (
    thinkingEntry.kind === 'tool-execution-group' &&
    thinkingEntry.executions.some((execution) => execution.call?.function.name === 'create_plan')
  ))
}

/** Inserts the completed-plan record after the turn that created its plan. */
export function insertCompletedPlanRecord(
  entries: readonly TimelineRenderEntry[],
  plan: PlanSnapshot | undefined,
): TimelineRenderEntry[] {
  if (plan?.status !== 'completed') return [...entries]

  let closestEntryIndex = -1
  let planCreationIndex = -1
  entries.forEach((entry, index) => {
    if (entry.createdAt <= plan.createdAt) closestEntryIndex = index
    if (createsPlan(entry) && entry.createdAt <= plan.createdAt) planCreationIndex = index
  })
  if (planCreationIndex === -1) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (createsPlan(entries[index])) {
        planCreationIndex = index
        break
      }
    }
  }
  const insertionIndex = planCreationIndex === -1 ? closestEntryIndex : planCreationIndex
  const record: CompletedPlanRecordEntry = {
    kind: 'completed-plan-record',
    createdAt: plan.createdAt,
    sortKey: `completed-plan:${plan.id}`,
  }
  return [
    ...entries.slice(0, insertionIndex + 1),
    record,
    ...entries.slice(insertionIndex + 1),
  ]
}

export function flattenTimelineVirtualEntries(
  entries: TimelineRenderEntry[],
  expandedGroups: Record<string, boolean>,
): TimelineVirtualEntry[] {
  return entries.flatMap((entry): TimelineVirtualEntry[] => {
    if (entry.kind !== 'thinking-group') return [entry]
    const header: TimelineVirtualEntry = {
      kind: 'thinking-header',
      createdAt: entry.createdAt,
      sortKey: entry.sortKey,
      group: entry,
    }
    if (expandedGroups[entry.sortKey] === false) return [header]
    return [
      header,
      ...entry.entries.map((thinkingEntry): TimelineVirtualEntry => ({
        kind: 'thinking-step-row',
        createdAt: thinkingEntry.createdAt,
        sortKey: `${entry.sortKey}:step:${thinkingEntry.sortKey}`,
        entry: thinkingEntry,
      })),
    ]
  })
}

export function timelineVirtualEntryVersion(entry: TimelineVirtualEntry): string {
  if (entry.kind === 'thinking-header') return `${entry.sortKey}:${entry.group.entries.length}`
  if (entry.kind === 'thinking-step-row') {
    const item = entry.entry
    if (item.kind === 'reasoning') return `${entry.sortKey}:${item.content.length}`
    if (item.kind === 'thinking-message' && item.conversationItem.item.role === 'assistant') {
      const { conversationItem } = item
      return `${entry.sortKey}:${conversationItem.item.content?.length ?? 0}:${conversationItem.pending ? 1 : 0}`
    }
    if (item.kind === 'tool-execution-group') {
      return `${entry.sortKey}:${item.executions.map((execution) => (
        `${execution.call?.id ?? ''}:${execution.result?.content.length ?? 0}`
      )).join('|')}`
    }
    return entry.sortKey
  }
  if (entry.kind === 'completed-plan-record') return entry.sortKey
  if (entry.kind === 'card') return `${entry.sortKey}:${entry.card.title.length}:${entry.card.body?.length ?? 0}`
  const item = entry.conversationItem.item
  const length = item.role === 'assistant' || item.role === 'user' ? item.content?.length ?? 0 : 0
  return `${entry.sortKey}:${length}:${entry.conversationItem.pending ? 1 : 0}`
}
