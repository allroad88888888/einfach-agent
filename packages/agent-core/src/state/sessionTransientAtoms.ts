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
