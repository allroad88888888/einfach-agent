import { atom } from '@einfach/core'
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

// 每个 atom 都是 session store 内的共享 key；值由各 session store 隔离，绝不按 sessionId 分桶。

// 当前会话的待保存文件产物。
export const pendingArtifactsAtom = atom<PendingArtifact[]>([])

// 当前会话的浏览器卡片。
export const browserCardsAtom = atom<BrowserCard[]>([])

// 当前会话的 AskUserQuestion 待提交答案（questionId → value）。
export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

// 当前会话正在跑的工具进度（按 callId）。
export const toolActivityAtom = atom<ToolActivity[]>([])

// 当前会话的 runtime transcript 调试事件；不进 checkpoint，也不参与 model messages。
export const runtimeTranscriptEventsAtom = atom<RuntimeTranscriptEvent[]>([])

// 当前会话正在生成的 assistant 消息；runId 用于阻止旧 run 清掉新 run 的流消息。
export const assistantStreamAtom = atom<AssistantStreamState | undefined>(undefined)

// 当前会话注入卡片的去重指纹；只服务 runtime 判重，不进 checkpoint、不持久化。
export const transcriptInjectionFingerprintsAtom = atom<TranscriptInjectionFingerprints>({})

// 当前会话「思考过程」分组的显式展开选择（group key → 是否展开）。
export const expandedTranscriptGroupsAtom = atom<Record<string, boolean>>({})

// 当前会话计划阶段详情的显式展开选择（stage id → 是否展开）。
export const expandedPlanStagesAtom = atom<Record<string, boolean>>({})

// 当前会话计划面板整体是否展开。
export const planPanelExpandedAtom = atom(true)

// 当前会话已完成计划记录是否展开；记录随消息列表滚动，不占用执行操作区。
export const completedPlanRecordExpandedAtom = atom(false)

// 当前会话最近一次 LLM 调用的上下文统计；不进 messages、不持久化、不回发给 model。
export const contextStatsAtom = atom<ContextStatsSnapshot | undefined>(undefined)

// 当前会话 Composer 草稿。
export const composerDraftAtom = atom<string>('')

// 当前会话等待注入正在运行 run 的用户输入（FIFO）。
export const queuedUserMessagesAtom = atom<QueuedUserMessage[]>([])

// 撤回当前未完成轮后的提示。
export const withdrawnTurnNoticeAtom = atom<WithdrawnTurnNotice | undefined>(undefined)

// 本 session「一律允许」的危险工具名集合；临时 UI 态，刷新即恢复每次确认的安全默认。
export const alwaysAllowedToolsAtom = atom<string[]>([])

/**
 * 撤销屏障：这条账目及更早的都**不许再撤销**，因为越过它会复活已被不可逆释放掉的内容。
 *
 * 立屏障的时机是「发生了跨进程边界的不可逆动作」—— 当前只有一处：用户显式停止 run 时，
 * `disposeUserContentAfterMutation` 会真的去删 provider 侧的上传。删掉之后再撤销
 * 就会把排队消息恢复成指向已删除上传的坏引用，而删除是收不回来的。
 *
 * 存的是账目的 `txId` 而不是下标：cap 溢出会整体左移下标，而 txId 不会变。屏障那条被 cap
 * 逐出之后，剩下的条目全都比它新，于是撤销全部放行 —— 这正是对的。
 *
 * **刻意不在 SESSION_SLOTS 里**：它不能被撤销，否则撤一步就把自己的守卫撤掉了。它也不进恢复
 * 快照，而是跟着撤销日志一起落盘（`PersistedHistoryLog.barrierTxId`）—— 屏障与它保护的那本账
 * 必须同生同死，分开存就会出现「账在、屏障没了」。
 */
export const undoBarrierTxIdAtom = atom<string | undefined>(undefined)
