import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import { canRememberToolApproval } from '../runtime/sessionApprovalMemory'
import { sessionsAtom } from './rootStore'
import {
  alwaysAllowedToolsAtom,
  assistantStreamAtom,
  browserCardsAtom,
  composerDraftAtom,
  contextStatsAtom,
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
  runtimeTranscriptEventsAtom,
  toolActivityAtom,
  transcriptInjectionFingerprintsAtom,
  withdrawnTurnNoticeAtom,
} from './sessionTransientAtoms'
import type { ContextStatsSnapshot } from './contextStats'
import { SESSION_SLOTS } from './sessionSlots'
import { writeSlot } from './sessionSlotWrite'
import type {
  AssistantStreamState,
  AskUserAnswerValue,
  BrowserCard,
  PendingArtifact,
  QueuedUserMessage,
  RuntimeTranscriptEvent,
  ToolActivity,
  TranscriptInjectionFingerprints,
  WithdrawnTurnNotice,
} from './sessionTransientPayloads'

// 会话未在 core.rootStore 登记时，所有写入都是 no-op，避免给幽灵会话写内容。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

export function addPendingArtifact(
  id: string,
  artifact: PendingArtifact,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.pendingArtifacts.key, pendingArtifactsAtom, (prev) => [...prev, artifact])
}

export function removePendingArtifact(
  id: string,
  artifactId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.pendingArtifacts.key, pendingArtifactsAtom, (prev) =>
    prev.filter((artifact) => artifact.id !== artifactId),
  )
}

export function addBrowserCard(id: string, card: BrowserCard, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(browserCardsAtom, (prev) => [...prev, card])
}

export function pruneBrowserCardsAfter(
  id: string,
  createdAt: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(browserCardsAtom, (prev) =>
    prev.filter((card) => card.createdAt <= createdAt),
  )
}

export function setPendingQuestionAnswer(
  id: string,
  questionId: string,
  value: AskUserAnswerValue,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.pendingQuestionAnswers.key, pendingQuestionAnswersAtom, (prev) => ({
    ...prev,
    [questionId]: value,
  }))
}

export function upsertToolActivity(
  id: string,
  activity: ToolActivity,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(toolActivityAtom, (prev) => {
    const index = prev.findIndex((entry) => entry.callId === activity.callId)
    if (index < 0) return [...prev, activity]
    const next = [...prev]
    next[index] = activity
    return next
  })
}

export function removeToolActivity(
  id: string,
  callId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(toolActivityAtom, (prev) =>
    prev.filter((entry) => entry.callId !== callId),
  )
}

export function addRuntimeTranscriptEvent(
  id: string,
  event: RuntimeTranscriptEvent,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(runtimeTranscriptEventsAtom, (prev) => [...prev, event])
}

export function setAssistantStream(
  id: string,
  stream: AssistantStreamState,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(assistantStreamAtom, stream)
}

export function clearAssistantStream(
  id: string,
  runId: string,
  itemId?: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(assistantStreamAtom, (current) => {
    if (!current || current.runId !== runId) return current
    if (itemId !== undefined && current.item.id !== itemId) return current
    return undefined
  })
}

export function pruneRuntimeTranscriptEventsAfter(
  id: string,
  createdAt: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(runtimeTranscriptEventsAtom, (prev) =>
    prev.filter((event) => event.createdAt <= createdAt),
  )
}

export function patchTranscriptInjectionFingerprints(
  id: string,
  patch: Partial<TranscriptInjectionFingerprints>,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(transcriptInjectionFingerprintsAtom, (prev) => ({
    ...prev,
    ...patch,
  }))
}

export function setContextStats(
  id: string,
  stats: ContextStatsSnapshot | undefined,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(contextStatsAtom, stats)
}

export function setComposerDraft(id: string, draft: string, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.composerDraft.key, composerDraftAtom, draft)
}

export function enqueueUserMessage(
  id: string,
  message: QueuedUserMessage,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.queuedUserMessages.key, queuedUserMessagesAtom, (prev) => [...prev, message])
}

export function takeQueuedUserMessages(
  id: string,
  runId: string,
  core: CoreInstance = defaultCore,
): QueuedUserMessage[] {
  if (sessionMissing(id, core)) return []
  const session = core.getSessionStore(id)
  const store = session.store
  const queued = store.getter(queuedUserMessagesAtom)
  const taken = queued.filter((message) => message.targetRunId === runId)
  if (taken.length > 0) {
    store.setter(
      queuedUserMessagesAtom,
      queued.filter((message) => message.targetRunId !== runId),
    )
  }
  return taken
}

export function clearQueuedUserMessages(
  id: string,
  core: CoreInstance = defaultCore,
): QueuedUserMessage[] {
  if (sessionMissing(id, core)) return []
  const session = core.getSessionStore(id)
  const store = session.store
  const queued = store.getter(queuedUserMessagesAtom)
  if (queued.length > 0) writeSlot(session, SESSION_SLOTS.queuedUserMessages.key, queuedUserMessagesAtom, [])
  return queued
}

export function setWithdrawnTurnNotice(
  id: string,
  notice: WithdrawnTurnNotice | undefined,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(withdrawnTurnNoticeAtom, notice)
}

export function clearPendingQuestionAnswers(id: string, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) return
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.pendingQuestionAnswers.key, pendingQuestionAnswersAtom, {})
}

export function addAlwaysAllowedTool(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): void {
  // 无记忆资格的工具（MCP 工具、连接工具）只对单次调用有效；写入器自己也拒绝，
  // 避免绕过命令层。判据单点见 runtime/sessionApprovalMemory.ts。
  if (!canRememberToolApproval(toolName) || sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(alwaysAllowedToolsAtom, (prev) =>
    prev.includes(toolName) ? prev : [...prev, toolName],
  )
}
