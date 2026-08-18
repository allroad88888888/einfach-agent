import type { ModelItem } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'
import type { ToolRegistry } from '../tools/toolRegistry'
import type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentChildSpec,
  DelegateAgentInput,
  SubagentNodeRecord,
  SubagentNodeStatus,
  SubagentPath,
} from '../subagents/types'
import type { CoreInstance } from './core/coreInstance'

export type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentNodeRecord,
} from '../subagents/types'

/** Input for reserving a set of child nodes in one delegation tree. */
export interface ReserveChildrenInput {
  treeId: string
  sessionId: string
  delegationCallId?: string
  parentPath: SubagentPath
  inheritedSkillFiles: string[]
  inheritedSkillIds: string[]
  children: DelegateAgentChildSpec[]
}

/** Scheduler port owned by an injected delegation capability. */
export interface SubagentScheduler {
  reserveChildren(input: ReserveChildrenInput): SubagentNodeRecord[]
  markNode(
    treeId: string,
    path: SubagentPath,
    status: SubagentNodeStatus,
    patch?: Partial<Omit<SubagentNodeRecord, 'treeId' | 'path'>>,
  ): SubagentNodeRecord | undefined
  snapshot(treeId: string): SubagentNodeRecord[]
  subscribe(listener: (node: SubagentNodeRecord) => void): () => void
  clear(treeId: string): void
}

/** Runtime ownership operations shared by every injected delegation implementation. */
export interface DelegationRuntimeLifecycle {
  retain?(): void
  release?(): void
  cancel?(): void
  dispose?(): void | Promise<void>
}

/** Public runtime surface needed by the main tool loop and tool context. */
export interface DelegationRuntime extends DelegationRuntimeLifecycle {
  delegateAgents(
    input: DelegateAgentInput,
    context: DelegateAgentCallContext,
  ): Promise<DelegateAgentBatchResult>
  runLowCostExtraction?(input: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }>
}

/** Per-run inputs supplied by the host; scheduler ownership stays with the capability. */
export interface DelegationRuntimeInput {
  sessionId: string
  runId: string
  settings: ModelSettings
  core?: CoreInstance
  registry?: ToolRegistry
  customInstructions?: string
  environment?: string
  hostHasLocalCapabilities?: boolean
  /** 不透明调用方标识；core 只透传，是否上行由 provider adapter 决定。 */
  modelUserId?: string
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  onNodeChange?(node: SubagentNodeRecord): void
  onTraceItem?(input: {
    agentPath: string
    timestamp: string
    turn: number
    item: ModelItem
  }): void
}

/**
 * A per-Core delegation capability. It owns the scheduler shared by every
 * delegate runtime created for that Core and exposes it to existing tree views.
 */
export interface DelegationCapability {
  readonly scheduler: SubagentScheduler
  createRuntime(input: DelegationRuntimeInput): Promise<DelegationRuntime>
}

/** Installs one independent delegation capability into a Core instance. */
export type DelegationRuntimeFactory = () => DelegationCapability
