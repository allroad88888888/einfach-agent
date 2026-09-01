import type { ModelItem } from '@einfach-agent/ai'

import type { AgentHistoryTarget } from './agentHistoryTarget'

export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_tool'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_plan_approval'
  | 'interrupted'
  | 'done'
  | 'stopped'
  | 'error'

export interface AgentSessionMetaMutationV1 {
  readonly mutationType: 'session_meta'
  readonly target: AgentHistoryTarget
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AgentTurnContextMutationV1 {
  readonly mutationType: 'turn_context'
  readonly target: AgentHistoryTarget
  readonly turnId: string | null
  readonly itemIds: readonly string[]
}

export interface AgentItemUpsertMutationV1 {
  readonly mutationType: 'item_upsert'
  readonly target: AgentHistoryTarget
  readonly itemId: string
  readonly itemOrdinal: number
  readonly createdAt: number
  readonly item: ModelItem
  readonly pending: boolean
  readonly planStageId: string | null
}

export interface AgentItemDeletedMutationV1 {
  readonly mutationType: 'item_deleted'
  readonly target: AgentHistoryTarget
  readonly itemId: string
  readonly reason: string
}

export interface AgentRunStateMutationV1 {
  readonly mutationType: 'run_state'
  readonly target: AgentHistoryTarget
  readonly runId: string | null
  readonly turnId: string | null
  readonly status: AgentRunStatus
  readonly error: string | null
}

export type AgentRolloutMutationV1 =
  | AgentSessionMetaMutationV1
  | AgentTurnContextMutationV1
  | AgentItemUpsertMutationV1
  | AgentItemDeletedMutationV1
  | AgentRunStateMutationV1

export type AgentRolloutRecordV1 = AgentRolloutMutationV1 & {
  readonly schemaVersion: 1
  readonly historyId: string
  readonly rolloutOrdinal: number
  readonly recordedAt: string
}

export interface AgentRolloutWarning {
  readonly kind: 'source' | 'projection'
  readonly code: string
  readonly message: string
}

export interface AgentRolloutAppendResult {
  readonly records: readonly AgentRolloutRecordV1[]
  readonly projectionWarning?: AgentRolloutWarning
}

export interface AgentRolloutReconcileHistoryResult {
  readonly historyId: string
  readonly recordsApplied: number
  readonly nextByteOffset: number
  readonly warning?: AgentRolloutWarning
}

export interface AgentRolloutReconcileResult {
  readonly histories: readonly AgentRolloutReconcileHistoryResult[]
}

export interface AgentRolloutDriver {
  append(
    target: AgentHistoryTarget,
    mutations: readonly AgentRolloutMutationV1[],
  ): Promise<AgentRolloutAppendResult>
  reconcile(): Promise<AgentRolloutReconcileResult>
  flush(): Promise<void>
}
