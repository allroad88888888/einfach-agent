import type { ModelItem } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'
import type { ToolRegistry } from '../tools/toolRegistry'
import { createSubagentScheduler, type SubagentScheduler } from '../subagents/schedulerState'
import type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentNodeRecord,
} from '../subagents/types'
import type { CoreInstance } from './core/coreInstance'

export type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentNodeRecord,
} from '../subagents/types'

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
  runtimeIsTauri?: boolean
  deepseekUserId?: string
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

/**
 * Transitional core implementation. E2 can replace this factory without
 * changing the main runtime consumers or the scheduler compatibility view.
 */
export const createDefaultDelegationRuntimeFactory: DelegationRuntimeFactory = () => {
  const scheduler = createSubagentScheduler()
  return {
    scheduler,
    async createRuntime(input) {
      const { createDelegateAgentRuntime } = await import('../subagents/runtime')
      return createDelegateAgentRuntime({ ...input, scheduler })
    },
  }
}
