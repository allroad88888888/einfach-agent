import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import { canRememberToolApproval } from '../runtime/sessionApprovalMemory'
import { sessionsAtom } from './rootStore'
import {
  alwaysAllowedToolsAtom,
  assistantStreamAtom,
  browserCardsAtom,
  contextStatsAtom,
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
  runtimeTranscriptEventsAtom,
  toolActivityAtom,
  transcriptInjectionFingerprintsAtom,
  withdrawnTurnNoticeAtom,
} from './sessionTransientAtoms'
import type { ContextCacheTotals, ContextStatsSnapshot } from './contextStats'
import { SESSION_SLOTS } from './sessionSlots'
import {
  appendPendingArtifactLogged,
  removePendingArtifactLogged,
} from './pendingArtifactsLog'
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
  // 走增量记账：产物条目装的是完整文件正文，整值记账会把已攒下的全部正文存进日志两遍
  // （理由见 state/pendingArtifactsLog.ts）。
  appendPendingArtifactLogged(core.getSessionStore(id), artifact)
}

export function removePendingArtifact(
  id: string,
  artifactId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  removePendingArtifactLogged(core.getSessionStore(id), artifactId)
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

/**
 * 把「从 trace 里补算出来的本次 run 累计缓存命中」并回当前统计。
 *
 * 存在的理由是 UI 拿不到这个数：`recoverCacheTotalsFromTrace` 是异步读观测库，只有渲染层会在
 * 看到 `cacheTotals.runId` 落后于当前 run 时去补。以前 `ContextStats.tsx` 直接
 * `useAtom(contextStatsAtom)` 就地写——那是渲染层写会话 atom，绕过收口点，而当时的门禁看不见
 * （它只按名字认槽位，contextStats 不是槽位，又是从 barrel import 的）。
 *
 * 两道 stale guard 逐字沿用组件里原来的判断：run 已经翻篇（`runId` 不符）、或这份累计已经补过
 * （`cacheTotals.runId` 已是当前 run），都原样返回，不写。
 */
export function mergeContextStatsCacheTotals(
  id: string,
  runId: string,
  cacheTotals: ContextCacheTotals,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  core.getSessionStore(id).store.setter(contextStatsAtom, (prev) => (
    prev?.runId === runId && prev.cacheTotals?.runId !== runId ? { ...prev, cacheTotals } : prev
  ))
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
