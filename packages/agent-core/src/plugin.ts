// @web-agent/core/plugin 的唯一公开入口。

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
export type { PluginCommandFacade } from './runtime/core/pluginCommandFacade'
export type { Tool } from './tools/types'
