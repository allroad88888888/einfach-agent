// 外部插件的公开契约。这个模块只投影宿主允许的能力，不引入运行时 Store、Atom 或 CoreCtx。

import type { Tool } from '../../tools/types'
import type { PluginCommandFacade } from './pluginCommandFacade'

const publicPluginBrand = Symbol('web-agent.public-plugin')

/** 可安全观察的当前 run 投影；不包含会话 Store、错误内容或待确认载荷。 */
export interface PluginRunSnapshot {
  readonly runId: string
  readonly status: PluginRunStatus
}

/** 对外稳定的 run 状态字面量，不暴露内部状态模型。 */
export type PluginRunStatus =
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

/** 已完成工具调用的只读投影；暂停控制流不会越过此边界。 */
export interface CompletedToolCallEvent {
  readonly callId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly result: CompletedToolResult
}

/** 已完成工具结果的只读投影。 */
export type CompletedToolResult =
  | {
      readonly ok: true
      readonly data?: unknown
      readonly warnings?: readonly string[]
    }
  | {
      readonly ok: false
      readonly error: string
      readonly code?: string
      readonly hint?: string
      readonly retryable?: boolean
      readonly details?: unknown
    }

export type RunObserver = (run: PluginRunSnapshot | undefined) => void

export type AfterToolCallObserver = (
  event: CompletedToolCallEvent,
) => void | Promise<void>

/** 每次 run 激活时提供给公开插件的受限能力。 */
export interface PluginRunApi {
  readonly commands: PluginCommandFacade
  observeRun(listener: RunObserver): void
  onAfterToolCall(listener: AfterToolCallObserver): void
}

/** 安装阶段只允许注册工具，不能读取或修改运行状态。 */
export interface PluginInstallApi {
  registerTool(tool: Tool): void
}

export type PluginDisposer = () => void

/** definePlugin 的输入形状；所有运行能力都在 activate 时按 run 注入。 */
export interface PublicPluginDefinition {
  install?(api: PluginInstallApi): void | PluginDisposer
  activate?(api: PluginRunApi): void | PluginDisposer
}

/** 由 definePlugin 施加运行时品牌的公开插件。 */
export interface PublicPlugin extends PublicPluginDefinition {
  readonly [publicPluginBrand]: true
}

/** 对外公开插件的简写名称。 */
export type Plugin = PublicPlugin

/** 创建不可伪装为旧内部插件的公开插件定义。 */
export function definePlugin(definition: PublicPluginDefinition): PublicPlugin {
  return Object.freeze({ ...definition, [publicPluginBrand]: true as const })
}

/** 识别经 definePlugin 创建的公开插件。 */
export function isPublicPlugin(value: unknown): value is PublicPlugin {
  return typeof value === 'object'
    && value !== null
    && (value as PublicPlugin)[publicPluginBrand] === true
}
