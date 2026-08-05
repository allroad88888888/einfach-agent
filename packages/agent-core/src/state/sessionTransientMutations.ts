import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
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
  core.getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) => [...prev, artifact])
}

export function removePendingArtifact(
  id: string,
  artifactId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) =>
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
  core.getSessionStore(id).store.setter(pendingQuestionAnswersAtom, (prev) => ({
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
  core.getSessionStore(id).store.setter(composerDraftAtom, draft)
}

export function enqueueUserMessage(
  id: string,
  message: QueuedUserMessage,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(queuedUserMessagesAtom, (prev) => [...prev, message])
}

export function takeQueuedUserMessages(
  id: string,
  runId: string,
  core: CoreInstance = defaultCore,
): QueuedUserMessage[] {
  if (sessionMissing(id, core)) return []
  const store = core.getSessionStore(id).store
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
  const store = core.getSessionStore(id).store
  const queued = store.getter(queuedUserMessagesAtom)
  if (queued.length > 0) store.setter(queuedUserMessagesAtom, [])
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
  core.getSessionStore(id).store.setter(pendingQuestionAnswersAtom, {})
}

export function addAlwaysAllowedTool(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): void {
  // MCP 授权只对单次调用有效；状态写入器也拒绝直接调用，避免绕过命令层。
  if (toolName.startsWith('mcp__') || sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(alwaysAllowedToolsAtom, (prev) =>
    prev.includes(toolName) ? prev : [...prev, toolName],
  )
}
