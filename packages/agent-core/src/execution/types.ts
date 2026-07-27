import type { ModelItem } from '@web-agent/ai'

export type ExecutionNodeType =
  | 'agent-batch'
  | 'agent'
  | 'model'
  | 'tool'
  | 'plan-stage'
  | 'evaluator'
  | 'join'

export type ExecutionNodeStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'waiting-children'
  | 'waiting-user'
  | 'interrupted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface ExecutionNode {
  id: string
  graphId: string
  sessionId: string
  runId: string
  parentId?: string
  dependsOn: string[]
  type: ExecutionNodeType
  status: ExecutionNodeStatus
  label: string
  attempt: number
  generation: number
  effectKeys: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  result?: unknown
  error?: string
  trace?: ExecutionTraceRecord[]
}

export interface ExecutionTraceRecord {
  timestamp: string
  turn: number
  item: ModelItem
}

export interface ExecutionGraphSnapshot {
  version: 1
  nodes: Record<string, ExecutionNode>
  order: string[]
}

export type ExecutionEvent =
  | { type: 'node.added'; node: ExecutionNode }
  | {
      type: 'node.status'
      nodeId: string
      status: ExecutionNodeStatus
      at: number
      attempt: number
      generation: number
      result?: unknown
      error?: string
    }
  | {
      type: 'node.trace'
      nodeId: string
      record: ExecutionTraceRecord
    }
  | { type: 'graph.hydrated'; at: number }

export interface ExecutionHandle {
  executionId: string
  graphId: string
  nodeIds: string[]
  status: 'scheduled'
}

export interface ExecutionObservation {
  node?: ExecutionNode
  children: ExecutionNode[]
}

export interface ExecutionJoinResult {
  executionId: string
  status: ExecutionNodeStatus
  result?: unknown
  error?: string
  /** True when join returned before a still-running execution reached a terminal state. */
  timedOut?: boolean
}
