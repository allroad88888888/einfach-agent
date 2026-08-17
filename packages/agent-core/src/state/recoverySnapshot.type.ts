// 中断恢复的持久化数据契约。
// ---------------------------------------------------------------------------
// 这是 session atom 值的序列化投影，不是另一套状态源：它不包含 atom/store 身份，且不能保存
// Promise、AbortController、函数或活跃进程。R2 负责把本契约与明确的 atom allowlist 对接。

import type { ExecutionGraphSnapshot } from '../execution/types'
import type { PlanSnapshot } from '../planning/types'
import type { PlanStageCheckpoint } from './planStageCheckpoint.type'
import type { ContextCheckpoint } from './contextCheckpoint.type'
import type { ConversationItem, RunState, SessionMeta } from './core.type'
import type { AskUserAnswerValue, PendingArtifact, QueuedUserMessage } from './sessionTransientPayloads'

/** 首个恢复快照 codec 的版本；未知版本必须 fail-closed。 */
export const RECOVERY_SNAPSHOT_SCHEMA_VERSION = 1 as const

/** 仅当一整代数据已经完整写入时，driver 才能写入此标记。 */
export const RECOVERY_SNAPSHOT_COMMIT_MARKER = 'complete' as const

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 活跃的 execution handle 是进程资源，绝不跨启动持久化。 */
export type RecoverableRunState = Omit<RunState, 'pendingExecutionId'> & {
  pendingExecutionId?: never
}

/**
 * 恢复时登记回 root sessionsAtom 的静态会话元数据。
 *
 * `plan` 与 `executionGraph` 的唯一真源是下方 `values` 的 session-store 投影，故这里刻意不复制。
 */
export type RecoverySessionMetaV1 = Pick<
  SessionMeta,
  | 'id'
  | 'title'
  | 'settings'
  | 'createdAt'
  | 'updatedAt'
  | 'workspaceId'
  | 'workspaceRoot'
  | 'toolApprovalMode'
  | 'loadedTools'
>

export type SubagentContinuationState =
  | 'queued'
  | 'interrupted'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_plan_approval'
  | 'outcome_unknown'

/**
 * 一个可在后续启动时重新调度的 child agent 描述。
 *
 * `spec` 只保存逻辑任务输入；R8 才会为它定义具体调度器、模型调用和工具 outcome 策略。
 */
export interface SubagentContinuationV1 {
  schemaVersion: 1
  childId: string
  parentRunId: string
  /** null 表示 child 直接由 root run 派生，没有 execution-graph 父节点。 */
  parentNodeId: string | null
  state: SubagentContinuationState
  spec: JsonValue
}

/** 由 R2 的 allowlist 从现有 atom 读取和写回的稳定逻辑字段。 */
export interface RecoveryAtomProjectionV1 {
  conversation: {
    items: ConversationItem[]
    /** `null` 精确表示 contextCheckpointAtom 的 `undefined`，避免 JSON 丢字段。 */
    contextCheckpoint: ContextCheckpoint | null
  }
  plan: {
    /** `null` 精确表示 planAtom 的 `undefined`。 */
    current: PlanSnapshot | null
    stageCheckpoints: PlanStageCheckpoint[]
  }
  /** `null` 精确表示 runAtom 的 `undefined`。 */
  run: RecoverableRunState | null
  queuedUserMessages: QueuedUserMessage[]
  pendingQuestionAnswers: Record<string, AskUserAnswerValue>
  /**
   * 等待用户保存的模型产物。它必须入快照：save_file 回给模型的结果只有 artifactId 与字节数，
   * `content` 不进 transcript，所以这个 atom 是它唯一的副本，丢了就再也算不回来。
   */
  pendingArtifacts: PendingArtifact[]
  /**
   * 未发送的输入框文本。回退/撤回会把用户原话从 items 截断并放回输入框，那一刻它就是这段
   * 用户内容的唯一副本；同一条命令随后提交的 generation 必须带上它。
   */
  composerDraft: string
  executionGraph: ExecutionGraphSnapshot
  /** 本 schema 唯一的 child 续接真源；空数组表示没有 child。 */
  subagentContinuations: SubagentContinuationV1[]
}

/**
 * 一个已完整提交的 session 恢复 generation。
 *
 * `generation` 由每个 session 的 writer 单调递增；本类型不实现写入策略。恢复读取方只接受
 * `commitMarker === 'complete'` 的版本 1 记录，故半写入记录和未来 codec 都不会被误 hydrate。
 */
export interface RecoverySnapshotV1 {
  schemaVersion: typeof RECOVERY_SNAPSHOT_SCHEMA_VERSION
  /** 此记录归属的 session，driver 不得跨 session 套用它。 */
  sessionId: string
  /** 捕获投影的墙钟时间；不参与 generation 的单调性判断。 */
  capturedAt: number
  generation: number
  commitMarker: typeof RECOVERY_SNAPSHOT_COMMIT_MARKER
  /** root sessionsAtom 的静态登记项；必须与 sessionId 同属一个会话。 */
  session: RecoverySessionMetaV1
  values: RecoveryAtomProjectionV1
}
