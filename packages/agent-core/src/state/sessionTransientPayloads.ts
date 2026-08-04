// 会话瞬态 atom 使用的 UI 载荷；数据不持久化，也不进入模型上下文。

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
  content: string
  targetRunId: string
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
