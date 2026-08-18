// @web-agent/host-node —— Node 侧的宿主能力实现（core 命令桥的一种）
// ---------------------------------------------------------------------------
// 公开面只有三组：装配入口、命令全集、类型契约。域实现（`config/` 及后续的 `workspace/`
// `shell/` `mcp/` …）**不出现在这里**——它们是路由表的零件，对外只经
// `createNodeHostInvoke` 一个入口生效，单独暴露只会多出一条要维护的公开面。
//
// 典型装配（宿主启动时一次，早于任何工具可能执行的时点）：
//
//   import { configureHostInvoke } from '@web-agent/core'
//   import { createNodeHostInvoke } from '@web-agent/host-node'
//   const invoke = createNodeHostInvoke({})
//   configureHostInvoke(() => Promise.resolve(invoke))
//
// core 收的是 loader 而不是已解析的 invoke，理由见 runtime/hostBridge.ts：登记要同步生效，
// 否则 `hasHostBridge()` 会有一段为 false 的窗口，工具在那段时间跑会报「宿主不支持」。

export { createNodeHostInvoke, NodeHostCommandError } from './createNodeHostInvoke'
export type { NodeHostCommandErrorReason } from './createNodeHostInvoke'

export {
  NODE_HOST_COMMAND_NAMES,
  NODE_HOST_COMMANDS_BY_DOMAIN,
  isNodeHostCommandName,
} from './commandNames'
export type { NodeHostCommandDomain, NodeHostCommandName } from './commandNames'

export type { NodeHostInvokeOptions } from './hostOptions'
export type { NodeHostCommandHandler, NodeHostRouteTable } from './routeTable'
export type { NodeHostCommandArgs } from './commandArgs'
export type {
  McpImplementationInfoArgs,
  WorkspaceChangeContextArgs,
  WorkspacePatchOperationArgs,
} from './commandPayloads'
