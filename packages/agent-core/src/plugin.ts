// @einfach-agent/core/plugin 的唯一公开入口。

export { createCore } from './runtime/core/createCore'
export {
  definePlugin,
  isPublicPlugin,
  type AfterToolCallObserver,
  type CompletedToolCallEvent,
  type CompletedToolResult,
  type PluginDisposer,
  type PluginInstallApi,
  type Plugin,
  type PluginRunApi,
  type PluginRunSnapshot,
  type PluginRunStatus,
  type PublicPlugin,
  type PublicPluginDefinition,
  type RunObserver,
} from './runtime/core/pluginContracts'
// 7 个 loop hook 槽的契约 —— 与仓内插件同一批槽（负责人 2026-08-20「给，同等权利」）。
// 信任裁决与「为什么不给 store」的理由见 pluginHookContracts.ts 文件头。
export type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  PluginHookContext,
  PluginLoopHooks,
  RequestDraft,
  ShouldStopDecision,
  ToolResultPatch,
  TurnEndDecision,
  TurnEndEvent,
} from './runtime/core/pluginHookContracts'
export type { PluginCommandFacade } from './runtime/core/pluginCommandFacade'
export type { Tool } from './tools/types'
