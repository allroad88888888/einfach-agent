import type { LoadedTool } from '../tools/types'
import type { SessionMeta } from '../state/core.type'
import type { CoreInstance } from './core/coreInstance'
import type { ToolLoopOptions } from './modelRunLifecycle'
import type { TraceAttributes, TraceSpan, TraceStatus } from '../observability/types'

export interface ToolLoopTrace {
  span: TraceSpan
  event(name: string, attrs?: TraceAttributes): void
  finish(status: Exclude<TraceStatus, 'running'>, eventName: string, attrs?: TraceAttributes, error?: unknown): void
}

export interface ToolLoopControl {
  isCurrent(): boolean
  isRunning(): boolean
}

export interface ToolLoopMutableState {
  visible: LoadedTool[]
  recentToolNames: string[]
  planContinuation?: string
  consecutivePlanTextTurns: number
  guardStageId?: string
  stageTurnsOnGuard: number
  lastStageSubmitRejection?: string
}

export interface ToolLoopBase {
  id: string
  runId: string
  opts: ToolLoopOptions
  core: CoreInstance
  turnId: string
  maxTurnTools: number
  settings: SessionMeta['settings']
  modelUserId?: string
  runtimeIsTauri: boolean
  stablePrefix: Awaited<ReturnType<typeof import('./modelTurnPrefix').buildStableModelPrefix>>
  trace: ToolLoopTrace
  control: ToolLoopControl
  state: ToolLoopMutableState
  pluginContext: ReturnType<typeof import('./core/coreCtx').makeCoreCtx>
  hooks: ReturnType<typeof import('./core/pluginApi').assemblePlugins>
  delegateRuntime: ReturnType<typeof import('../subagents/runtime').createDelegateAgentRuntime>
  rootTranscript(): string
  promoteQueuedInputs(): number
}
