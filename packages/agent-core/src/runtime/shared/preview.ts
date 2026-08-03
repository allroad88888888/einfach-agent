import type { AssistantItem, ModelResponseMessage } from '@web-agent/ai'
import { truncatePayload } from '../../observability/redact'

/** Converts a value into a bounded trace representation. */
export function tracePreview(value: unknown, limit = 500): string {
  return truncatePayload(value, limit)
}

/** Serializes a value for token and context statistics. */
export function stringForStats(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Creates an assistant conversation item from a model response. */
export function assistantItemFromMessage(
  msg: ModelResponseMessage | undefined,
  content: string | null,
  toolCalls?: AssistantItem['tool_calls'],
): AssistantItem {
  const item: AssistantItem = {
    role: 'assistant',
    content,
  }
  const reasoningContent = msg?.reasoning_content
  if (reasoningContent) item.reasoning_content = reasoningContent
  if (toolCalls && toolCalls.length > 0) item.tool_calls = toolCalls
  return item
}
