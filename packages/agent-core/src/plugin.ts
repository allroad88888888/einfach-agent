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
// 会话与跨会话状态的受限读写面（F2b，负责人 2026-08-20「给，读写同理」）。入口是
// PluginHookContext.state；这里只导出它的**类型**，atom 引用与 einfach Store 一概不出公开面
// —— 理由（记账的机械要求，不是信任）见 pluginStateContracts.ts 文件头。
export type {
  PluginRootView,
  PluginSessionView,
  PluginStateAccess,
} from './runtime/core/pluginStateContracts'
// 上面那三个视图引用到的值类型。跟着一起导出，插件才写得出 `const items: ConversationItem[] = …`
// 这种标注；不导出的话它们只能靠结构类型推断，写不出名字。
export type { ContextCheckpoint } from './state/contextCheckpoint.type'
export type { ConversationItem } from './state/core.type'
export type { ModelItem } from '@einfach-agent/ai'
export type { Tool } from './tools/types'
