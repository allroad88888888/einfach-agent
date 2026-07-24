import type { ModelItem } from '@web-agent/ai'

export type SubagentPath = string

export type DelegateAgentStrategy = 'parallel_wait_all' | 'parallel_best_effort'
export type DelegateAgentBatchStatus = 'done' | 'partial' | 'failed' | 'cancelled'
export type SubagentToolProfile = 'delegate_only' | 'workspace_read'
export type SubagentArchiveWriteMode = 'create' | 'overwrite' | 'append'
export type SubagentSkillPromotion = 'ephemeral' | 'candidate' | 'promoted' | 'archived'

export type SubagentArchiveEventType =
  | 'archive_initialized'
  | 'delegate_requested'
  | 'children_reserved'
  | 'skill_written'
  | 'child_started'
  | 'child_tool_schema_requested'
  | 'child_tool_finished'
  | 'nested_delegate_requested'
  | 'child_finished'
  | 'tree_snapshot_written'
  | 'delegate_finished'
  // 每次 child / evaluator / distill 模型请求的 provider usage 与缓存 profile。
  // usage 没有缓存字段时仍保留事件，并明确标为 unavailable，不能伪装成 0% 命中。
  | 'child_model_usage'
  // 子 agent 上下文压缩的可观测性（对齐主循环 modelRun 的 llm.context_compacted /
  // llm.context_over_budget）。前者：本轮请求体里的历史工具正文被摘要过；
  // 后者：四级降级跑完仍超预算（请求照发、大概率换来硬 400）—— 它与前者【相互独立】，
  // 消息只有 [system,user] 时会是 compacted:false + withinBudget:false，那正是最该报警的形态。
  // 新增类型时记得同步 replay.ts 的 SUBAGENT_EVENT_TYPES 白名单，否则 replay 会把它判为
  // 'invalid subagent archive event structure' 丢进 parseErrors。
  | 'child_context_compacted'
  | 'child_context_over_budget'

export interface SubagentArchiveEvent {
  eventId: string
  type: SubagentArchiveEventType
  timestamp: string
  conversationId: string
  runId: string
  treeId: string
  agentPath: string
  data?: Record<string, unknown>
}

export type SubagentNodeStatus =
  | 'queued'
  | 'distilling'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface DelegateAgentChildSpec {
  objective: string
  mode?: string
  expectedOutput?: string
  maxDepth?: number
  maxChildren?: number
  maxTurns?: number
  toolProfile?: SubagentToolProfile
  confirmedTools?: string[]
}

export interface DelegateAgentInput {
  children: DelegateAgentChildSpec[]
  strategy?: DelegateAgentStrategy
  maxDepth?: number
  maxChildren?: number
  maxConcurrent?: number
  maxTotalNodes?: number
  maxModelCalls?: number
  toolProfile?: SubagentToolProfile
  confirmedTools?: string[]
}

export interface SubagentNodeRecord {
  id: string
  treeId: string
  sessionId: string
  path: SubagentPath
  parentPath?: SubagentPath
  /** The concrete delegate_agent tool call which created this node. */
  delegationCallId?: string
  status: SubagentNodeStatus
  objective: string
  mode?: string
  expectedOutput?: string
  depth: number
  dispatchCounter: number
  childCounter: number
  createdAt: number
  updatedAt: number
  inheritedSkillFiles: string[]
  inheritedSkillIds: string[]
  localSkillFiles: string[]
  localSkillIds: string[]
  resultFile?: string
  error?: string
}

export interface SubagentSkillSource {
  parentAgentPath?: SubagentPath
  parentSkillIds: string[]
  transcriptChars: number
}

export interface SubagentSkillFile {
  skillId: string
  conversationId: string
  runId: string
  path: string
  globalPath: string
  filename: string
  agentPath: SubagentPath
  kind: string
  content: string
  contentHash: string
  createdAt: string
  ttl: 'session' | 'permanent'
  promotion: SubagentSkillPromotion
  inherits: string[]
  inheritSkillIds: string[]
  source: SubagentSkillSource
}

export interface ChildAgentResult {
  path: SubagentPath
  status: 'done' | 'failed' | 'cancelled'
  objective: string
  summary: string
  resultFile?: string
  skillFiles: string[]
  skillIds: string[]
  /** Workspace mutations performed by this child, in execution order. */
  changeSets?: Array<{ id: string; reversible: boolean }>
  error?: string
}

export interface DelegateAgentBatchResult {
  treeId: string
  conversationId: string
  runId: string
  parentPath: SubagentPath
  strategy: DelegateAgentStrategy
  status: DelegateAgentBatchStatus
  summary: {
    total: number
    done: number
    failed: number
    cancelled: number
  }
  cacheBasePath: string
  archiveBasePath: string
  eventLog: string
  skillFiles: string[]
  skillIds: string[]
  budgetUsage?: {
    totalNodes: { used: number; limit: number }
    modelCalls: { used: number; limit: number }
  }
  /** De-duplicated workspace mutations from all descendants, in execution order. */
  changeSets?: Array<{ id: string; reversible: boolean }>
  reversible?: boolean
  children: ChildAgentResult[]
}

/**
 * 宿主针对单次 delegate 调用签发的危险工具能力。它必须同时绑定会话、run、tool call 和
 * 父节点路径；模型只能请求其中的子集，不能自行构造或扩大此能力。
 */
export interface SubagentDangerousToolCapability {
  sessionId: string
  runId: string
  delegationCallId: string
  parentPath: SubagentPath
  toolNames: readonly string[]
}

export interface DelegateAgentCallContext {
  parentPath: SubagentPath
  /** Host identity of the current delegate_agent tool call; checked independently from the capability. */
  delegationCallId?: string
  parentTranscript?: string
  inheritedSkillFiles?: string[]
  inheritedSkillIds?: string[]
  inheritedSkillContents?: SubagentSkillFile[]
  dangerousToolCapability?: SubagentDangerousToolCapability
  progress(text: string): void
  writeTextFile?(input: { path: string; content: string; mode?: SubagentArchiveWriteMode }): Promise<unknown>
  // warnings：参数被 schema 钳位过时由 registry 附加，必须一路带到子 agent 的 tool 结果里
  // （与主循环 appendMappedToolResult 同口径）——否则子 agent 会把被截断的结果当完整结果推理。
  runChildTool?(name: string, args: unknown): Promise<
    | { ok: true; data?: unknown; warnings?: string[] }
    | { ok: false; error: string }
  >
}

export interface DelegateAgentRuntime {
  delegateAgents(input: DelegateAgentInput, context: DelegateAgentCallContext): Promise<DelegateAgentBatchResult>
  retain?(): void
  release?(): void
  cancel?(): void
  dispose?(): void | Promise<void>
}

export interface SubagentRuntimeTranscript {
  messages: ModelItem[]
  text: string
}
