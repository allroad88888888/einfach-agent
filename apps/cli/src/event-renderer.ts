import {
  assistantStreamAtom,
  defaultCore,
  itemsAtom,
  subscribeAgentEvents,
  type AgentEvent,
} from '@einfach-agent/core'

export interface TextOutput {
  write(text: string): void
}

function toolNameByCallId(sessionId: string): Map<string, string> {
  const names = new Map<string, string>()
  const store = defaultCore.getSessionStore(sessionId).store
  for (const entry of store.getter(itemsAtom)) {
    if (entry.item.role !== 'assistant') continue
    for (const call of entry.item.tool_calls ?? []) names.set(call.id, call.function.name)
  }
  return names
}

function toolSummary(content: string): string {
  try {
    const value: unknown = JSON.parse(content)
    if (value && typeof value === 'object' && 'error' in value) return `error ${String(value.error).slice(0, 160)}`
  } catch {
    // Tool results are allowed to be plain text.
  }
  return 'ok'
}

function timedToolName(callId: string): string | undefined {
  const parts = callId.split(':')
  return parts[0] === 'timed' && parts.length >= 3 ? parts[parts.length - 1] : undefined
}

function renderToolEvent(sessionId: string, output: TextOutput, event: AgentEvent): void {
  if (event.type === 'message_appended' && event.item.item.role === 'tool') {
    const names = toolNameByCallId(sessionId)
    const name = names.get(event.item.item.tool_call_id) ?? timedToolName(event.item.item.tool_call_id) ?? '工具'
    output.write(`[tool] ${name} → ${toolSummary(event.item.item.content)}\n`)
  }
}

function renderAssistantStream(sessionId: string, output: TextOutput, streamed: Map<string, string>): void {
  const item = defaultCore.getSessionStore(sessionId).store.getter(assistantStreamAtom)?.item
  if (!item || item.item.role !== 'assistant' || !item.item.content) return
  const previous = streamed.get(item.id)
  if (previous === undefined) {
    output.write(`[assistant] ${item.item.content}`)
  } else if (item.item.content.startsWith(previous)) {
    output.write(item.item.content.slice(previous.length))
  } else {
    output.write(`\n[assistant] ${item.item.content}`)
  }
  streamed.set(item.id, item.item.content)
}

function renderCompletedAssistants(
  sessionId: string,
  output: TextOutput,
  streamed: Map<string, string>,
  rendered: Set<string>,
): void {
  const items = defaultCore.getSessionStore(sessionId).store.getter(itemsAtom)
  for (const entry of items) {
    if (entry.pending || entry.item.role !== 'assistant' || !entry.item.content || rendered.has(entry.id)) continue
    const streamedContent = streamed.get(entry.id)
    if (streamedContent === undefined) {
      output.write(`[assistant] ${entry.item.content}\n`)
    } else if (entry.item.content.startsWith(streamedContent)) {
      output.write(`${entry.item.content.slice(streamedContent.length)}\n`)
    } else {
      output.write(`\n[assistant] ${entry.item.content}\n`)
    }
    rendered.add(entry.id)
    streamed.delete(entry.id)
  }
}

/** Observes core stream and message events, rendering only human-readable CLI lines. */
export function subscribeCliRenderer(sessionId: string, output: TextOutput): () => void {
  const store = defaultCore.getSessionStore(sessionId).store
  const streamed = new Map<string, string>()
  const rendered = new Set(
    store.getter(itemsAtom)
      .filter((entry) => !entry.pending && entry.item.role === 'assistant')
      .map((entry) => entry.id),
  )
  const unsubscribeEvents = subscribeAgentEvents(sessionId, (event) => renderToolEvent(sessionId, output, event))
  const unsubscribeItems = store.sub(itemsAtom, () => renderCompletedAssistants(sessionId, output, streamed, rendered))
  const unsubscribeStream = store.sub(assistantStreamAtom, () => renderAssistantStream(sessionId, output, streamed))
  return () => {
    unsubscribeEvents()
    unsubscribeItems()
    unsubscribeStream()
  }
}
