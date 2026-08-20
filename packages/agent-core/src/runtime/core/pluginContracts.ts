// 外部插件的公开契约。这个模块只投影宿主允许的能力，不引入运行时 Store、Atom 或 CoreCtx。

import type { Tool } from '../../tools/types'
import type { PluginCommandFacade } from './pluginCommandFacade'
import type { PluginLoopHooks } from './pluginHookContracts'

/**
 * 品牌用【全局注册表 Symbol】而不是模块局部 `Symbol()`。
 *
 * 理由：这道校验的目的是「防裸对象误装」——把一个手写的 `{ install(){} }` 或旧内部插件的函数
 * 形状挡在 definePlugin 之外，不是安全边界。外部插件本就与宿主同权运行（蓝图 3.4：capabilities
 * 是申报不是沙箱），伪造品牌得不到任何多余能力，所以「不可伪造」不值得用可识别性去换。
 *
 * 而模块局部 Symbol 会把校验变成「必须命中同一份模块实例」：
 * - CLI：插件经 Node 的 node_modules 解析拿到 `@einfach-agent/core/plugin`，与 CLI 自己经别名加载的
 *   那份未必是同一个实例；
 * - 桌面：blob 求值的插件解析不了裸说明符，得由宿主在求值前重写到它自己的契约模块桥；
 * - 将来 npm 分发：装两份 @einfach-agent/core 是常态。
 * 这三条路径下 `Symbol.for` 天然可识别，`Symbol()` 则会让一个完全合规的插件莫名其妙过不了校验。
 */
const publicPluginBrand: unique symbol = Symbol.for('web-agent.public-plugin')

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

/**
 * 每次 run 激活时提供给公开插件的能力。
 *
 * `hook` 与仓内 AgentPlugin 的注册面**同名同形、同一批 7 个槽**（负责人 2026-08-20 裁决
 * 「给，同等权利」）：外部插件可以用 `beforeToolCall` 返回 `{ block: true }` 拦下工具执行，
 * 也可以在 `transformContext` / `prepareRequest` 里改模型这一轮看到的上下文。
 *
 * **状态的读与写不在这一层**：它挂在每个 hook 拿到的 `PluginHookContext.state` 上（F2b，
 * 「给，读写同理」）。挂那里而不是挂这里，是因为写入要过的三道门（ghost guard、runId stale
 * guard、AbortSignal）正是 ctx 已经带着的那三样；run 级 API 上没有它们，只能照着再造一份同款
 * 判据，而两份判据迟早漂移。这一层留下的是**不需要那三道门**的能力：`commands` 是给宿主命令层
 * 的委派（自带 run 作用域判定），`observeRun` 是纯观察。
 *
 * 放开的依据、信任姿态（装插件 = 完全信任）以及仍然不给裸 `Store` 的理由，见
 * pluginHookContracts.ts 文件头。
 */
export interface PluginRunApi {
  readonly commands: PluginCommandFacade
  observeRun(listener: RunObserver): void
  /** 注册一个 loop hook。槽名与语义见 PluginLoopHooks。 */
  hook<K extends keyof PluginLoopHooks>(name: K, fn: NonNullable<PluginLoopHooks[K]>): void
  /** 只观察已完成工具调用的窄面；等价于不返回补丁的 `hook('afterToolCall', ...)`。 */
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
