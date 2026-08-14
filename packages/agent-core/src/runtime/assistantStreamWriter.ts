import type { AssistantItem, ModelResponseMessage, ModelStreamDelta } from '@web-agent/ai'
import { appendItem, updateItem } from '../state/sessionWriters'
import { clearAssistantStream, setAssistantStream } from '../state/transientAtoms'
import type { ConversationItem } from '../state/core.type'
import type { CoreInstance } from './core/coreInstance'
import { newId } from './newId'
import { assistantItemFromMessage } from './shared/preview'
import { isCurrentRun } from './shared/runGuards'
import { isRunningRun } from './toolLoopSupport'

const STREAM_UPDATE_INTERVAL_MIN_MS = 150
const STREAM_UPDATE_INTERVAL_MAX_MS = 250

/** Owns the transient assistant entry produced by one streaming model response. */
export function createAssistantStreamWriter(id: string, runId: string, signal: AbortSignal, core: CoreInstance, planStageId?: string) {
  let assistantItemId: string | undefined
  let assistantCreatedAt: number | undefined
  let content = ''
  let reasoningContent = ''
  let lastFlushAt = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const canWrite = (ignoreAbort = false) => (ignoreAbort || !signal.aborted) && isRunningRun(id, runId, core)
  const currentMessage = (): ModelResponseMessage => ({ role: 'assistant', content, reasoning_content: reasoningContent || null })
  const streamUpdateInterval = () => {
    const chars = content.length + reasoningContent.length
    return chars >= 48_000 ? STREAM_UPDATE_INTERVAL_MAX_MS : chars >= 16_000 ? 200 : STREAM_UPDATE_INTERVAL_MIN_MS
  }
  const currentConversationItem = (): ConversationItem | undefined => assistantItemId && assistantCreatedAt !== undefined
    ? {
        id: assistantItemId,
        createdAt: assistantCreatedAt,
        pending: true,
        ...(planStageId !== undefined ? { planStageId } : {}),
        item: assistantItemFromMessage(currentMessage(), content),
      }
    : undefined
  const cancelScheduledFlush = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    flushTimer = undefined
  }
  const flush = (force = false): void => {
    if ((!content.trim() && !reasoningContent.trim()) || !canWrite()) return
    const now = Date.now()
    if (!assistantItemId) {
      assistantItemId = newId()
      assistantCreatedAt = now
      const streamItem = currentConversationItem()
      if (!streamItem) return
      appendItem(id, streamItem, core)
      setAssistantStream(id, { runId, item: streamItem }, core)
      lastFlushAt = now
      return
    }
    const remainingMs = streamUpdateInterval() - (now - lastFlushAt)
    if (!force && remainingMs > 0) {
      if (flushTimer === undefined) flushTimer = setTimeout(() => { flushTimer = undefined; flush(true) }, remainingMs)
      return
    }
    cancelScheduledFlush()
    const streamItem = currentConversationItem()
    if (!streamItem) return
    setAssistantStream(id, { runId, item: streamItem }, core)
    lastFlushAt = now
  }
  return {
    onDelta(delta: ModelStreamDelta): void { if (typeof delta.content === 'string') content += delta.content; if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content; flush() },
    finalize(msg: ModelResponseMessage | undefined, toolCalls?: AssistantItem['tool_calls'], contentSuffix?: string): string | undefined {
      cancelScheduledFlush()
      if (!assistantItemId) return undefined
      if (!canWrite()) { clearAssistantStream(id, runId, assistantItemId, core); return assistantItemId }
      const baseContent = typeof msg?.content === 'string' ? msg.content : content
      const finalContent = contentSuffix ? `${baseContent}${contentSuffix}` : baseContent
      const finalMsg: ModelResponseMessage = { role: 'assistant', content: finalContent, reasoning_content: msg?.reasoning_content ?? (reasoningContent || null), tool_calls: msg?.tool_calls }
      updateItem(id, assistantItemId, { pending: false, item: assistantItemFromMessage(finalMsg, finalContent, toolCalls) }, core)
      clearAssistantStream(id, runId, assistantItemId, core)
      return assistantItemId
    },
    finishPending(): void {
      cancelScheduledFlush()
      if (!assistantItemId) return
      if (isCurrentRun({ root: core.rootStore, getStore: () => core.getSessionStore(id).store, sessionId: id, runId })) updateItem(id, assistantItemId, { pending: false, item: assistantItemFromMessage(currentMessage(), content) }, core)
      clearAssistantStream(id, runId, assistantItemId, core)
    },
    hasItem: () => assistantItemId !== undefined,
  }
}
