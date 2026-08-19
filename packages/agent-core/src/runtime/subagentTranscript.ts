import { userMessageTracePreview, type ModelItem } from '@einfach-agent/ai'

export function compactSubagentTranscript(value: string, limit: number): string {
  const trimmed = value.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n...[truncated]` : trimmed
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatModelItem(item: ModelItem): string {
  if (item.role === 'user') {
    const preview = userMessageTracePreview(item.content)
    const imageSummary = preview.imageCount ? `\n[${preview.imageCount} image(s)]` : ''
    return `user:\n${compactSubagentTranscript(`${preview.text}${imageSummary}`, 2_000)}`
  }
  if (item.role === 'tool') return `tool ${item.tool_call_id}:\n${compactSubagentTranscript(item.content, 2_000)}`
  if (item.role === 'system') return `system:\n${compactSubagentTranscript(item.content, 2_000)}`

  const content = typeof item.content === 'string' ? item.content : ''
  const toolCalls = item.tool_calls?.length ? `\ntool_calls: ${safeJson(item.tool_calls)}` : ''
  return `assistant:\n${compactSubagentTranscript(content, 2_000)}${toolCalls}`
}

/** Formats a bounded parent transcript for delegate-agent inheritance and distillation. */
export function formatSubagentTranscript(items: ModelItem[], limit = 16_000): string {
  return compactSubagentTranscript(items.map(formatModelItem).join('\n\n---\n\n'), limit)
}
