import type { LoadedTool } from '../tools/types'
import type { SessionMeta } from '../state/core.type'
import type { CoreInstance } from './core/coreInstance'
import type { PluginRun } from './core/pluginHost'
import type { ToolLoopOptions } from './modelRunLifecycle'
import type { ToolEpoch } from './toolEpoch'
import type { TraceAttributes, TraceSpan, TraceStatus } from '../observability/port'
import type { DelegationRuntime } from './delegationContract'

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
  /** 活跃计划内被 pin 的工具名(不被 LRU 淘汰);计划结束清空,新 run 从空开始。 */
  planPinnedTools: string[]
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
  /**
   * 本 run 固定的工具目录。所有「给模型看」的读（manifest、发现分页、可见 schema、
   * 暴露的 registrationVersion）都必须走它，不要直接读 core.tools——那是活的、随时会变。
   * 真正执行仍走 core.tools，注册版本对不上时由 registry 自己 fail-closed。
   */
  toolEpoch: ToolEpoch
  turnId: string
  maxTurnTools: number
  settings: SessionMeta['settings']
  modelUserId?: string
  hostHasLocalCapabilities: boolean
  stablePrefix: Awaited<ReturnType<typeof import('./modelTurnPrefix').buildStableModelPrefix>>
  trace: ToolLoopTrace
  control: ToolLoopControl
  state: ToolLoopMutableState
  pluginContext: ReturnType<typeof import('./core/coreCtx').makeCoreCtx>
  pluginRun: PluginRun
  hooks: PluginRun['hooks']
  /** 本轮由可选 delegation capability 创建；未装配时子 Agent 工具不可用。 */
  delegateRuntime?: DelegationRuntime
  rootTranscript(): string
  promoteQueuedInputs(): number
}
