import type { AssistantItem, ToolItem } from '@web-agent/ai'
import type { SubagentNodeStatus } from '@web-agent/core/subagents/types'

export type SubagentTreeViewStatus = SubagentNodeStatus | 'interrupted'

export interface SubagentTreeViewNode {
  key: string
  path: string
  parentPath?: string
  depth: number
  status: SubagentTreeViewStatus
  objective: string
  summary?: string
  error?: string
  resultFile?: string
  skillFiles: string[]
  skillIds: string[]
  trace?: SubagentTraceRecord[]
}

export interface SubagentTreeView {
  // UI 批次身份必须使用 tool call id；同一 run 内多次顶层 delegate 会共享 treeId。
  id: string
  treeId: string
  callId: string
  createdAt: number
  status: SubagentTreeViewStatus
  strategy?: string
  archiveBasePath?: string
  nodes: SubagentTreeViewNode[]
  source?: 'live' | 'archive'
  eventLog?: string
  warnings?: string[]
}

export type SubagentArchiveLoadStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface SubagentArchiveLoadState {
  archiveBasePath: string
  workspaceRoot?: string
  status: SubagentArchiveLoadStatus
  tree?: SubagentTreeView
  eventsText?: string
  error?: string
}

export interface SubagentArchivePreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  kind?: 'result' | 'events'
  path?: string
  nodeKey?: string
  content?: string
  error?: string
}

export interface SubagentTraceRecord {
  timestamp: string
  turn: number
  item: AssistantItem | ToolItem
}

export interface SubagentTraceState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  path?: string
  nodeKey?: string
  records: SubagentTraceRecord[]
  warnings: string[]
  error?: string
}

export interface GlobalSubagentRun {
  key: string
  conversationId: string
  runId: string
  status: string
  archiveBasePath: string
  eventLog?: string
  model?: string
  vendor?: string
  startedAt?: string
  updatedAt?: string
}

export interface GlobalSubagentRunsState {
  workspaceRoot?: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  runs: GlobalSubagentRun[]
  warnings: string[]
  hasMore: boolean
  loadingMore?: boolean
  cursor?: string
  snapshot?: string
  error?: string
}

export interface GlobalSubagentRunSelection {
  archiveBasePath: string
  workspaceRoot?: string
}
