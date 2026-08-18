// 会话瞬态 atom 使用的 UI 载荷。
//
// **别被文件名和"瞬态"骗了：这里有三个类型是会落盘的。** `PendingArtifact`、
// `QueuedUserMessage`、`AskUserAnswerValue` 分别是 `pendingArtifacts` / `queuedUserMessages` /
// `pendingQuestionAnswers` 三个**槽位**的载荷，全都进 `RecoverySnapshotV1`（见
// recoverySnapshot.type.ts 的 `RecoveryAtomProjectionV1`）。
//
// 本行原文曾写「数据不持久化，也不进入模型上下文」——那是错的，而且是会误导人做出错误分类的错：
// 「transient 文件里的东西都不持久化」这条直觉在这里不成立。判据只有一条，见 sessionSlots.ts：
// **这份内容除了它自己还活在哪里？** 按模块名分类必然分错。

import type { UserMessageContent } from '@web-agent/ai'
import type { ConversationItem } from './core.type'

export interface PendingArtifact {
  id: string
  filename: string
  content: string
  mimeType?: string
}

export interface BrowserCard {
  id: string
  createdAt: number
  title: string
  body?: string
}

export type AskUserAnswerValue = string | string[] | boolean

export interface ToolActivity {
  callId: string
  toolName: string
  text: string
}

export type RuntimeTranscriptEventKind = 'system_injection' | 'tool_manifest'

export interface RuntimeTranscriptEvent {
  id: string
  createdAt: number
  kind: RuntimeTranscriptEventKind
  title: string
  summary?: string
  detail?: string
}

export interface AssistantStreamState {
  runId: string
  item: ConversationItem
}

export interface WithdrawnTurnNotice {
  id: string
  createdAt: number
  text: string
  sideEffects: boolean
}

export interface QueuedUserMessage {
  id: string
  createdAt: number
  content: UserMessageContent
  targetRunId: string
  /** Monotonic within this Core instance; optional for persisted legacy queue entries. */
  submissionSequence?: number
}

export interface TranscriptInjectionFingerprints {
  system?: string
  environment?: string
  customInstructions?: string | null
  skillManifest?: string
  toolManifest?: string
  toolsFingerprint?: string
  toolsCount?: number
}
