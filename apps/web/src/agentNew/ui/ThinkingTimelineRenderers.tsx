// Core 思考类时间线 item 到既有 Web 思考轨迹视觉的逐 kind 适配。

import type {
  TimelineReasoningItem,
  TimelineRuntimeEventItem,
  TimelineThinkingMessageItem,
  TimelineToolExecutionItem,
} from '@web-agent/core/timeline'
import { ThinkingStep } from './ThoughtTraceEntries'

export function ReasoningTimelineRenderer({ item }: { readonly item: TimelineReasoningItem }) {
  return <ThinkingStep entry={item} />
}

export function ThinkingMessageTimelineRenderer({ item }: { readonly item: TimelineThinkingMessageItem }) {
  return <ThinkingStep entry={item} />
}

export function ToolExecutionTimelineRenderer({ item }: { readonly item: TimelineToolExecutionItem }) {
  return <ThinkingStep entry={item} />
}

export function RuntimeEventTimelineRenderer({ item }: { readonly item: TimelineRuntimeEventItem }) {
  return <ThinkingStep entry={item} />
}
