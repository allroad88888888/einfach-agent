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

// 【S5：为什么这里多了一个「宿主事实」】上面那句「域实现不出现在这里」有一个例外，理由是
// 权威而不是方便：core 侧要把「这台机器是什么平台」告诉模型（注入的「运行环境」段），而**校验**
// 它的是 shell 域的 `platform mismatch`。这两处必须是同一个函数的答案，否则模型按 A 平台组命令、
// 桥按 B 平台拒绝——浏览器（macOS）连本机 Node 服务（Linux）时这条必然发生，`run_shell_command`
// 整个不可用。所以宿主装配层（`apps/server` 的握手、`apps/cli` 的桥登记）直接报这个值，
// 而不是各自再写一份 `process.platform` 映射。
export { currentPlatform as nodeHostPlatform } from './shell/platform'
export type { CurrentPlatform as NodeHostPlatform } from './shell/platform'

export type { NodeHostInvokeOptions } from './hostOptions'
export type { NodeHostCommandHandler, NodeHostRouteTable } from './routeTable'
export type { NodeHostCommandArgs } from './commandArgs'
export type {
  McpImplementationInfoArgs,
  WorkspaceChangeContextArgs,
  WorkspacePatchOperationArgs,
} from './commandPayloads'

// events 域：宿主的**反向通道**。本域没有命令，不进路由表、不在 commandNames.ts 的 28 条里——
// `HostInvoke` 的 `(cmd, args) => Promise<T>` 只能表达「我问、宿主答」，装不下宿主主动发生的事
// （MCP 子进程自己退了、它的工具清单变了）。它是与 createNodeHostInvoke 并列的第二条导出面，
// 设计理由见 src/events/index.ts。
export {
  createHostEventBus,
  HOST_EVENT_NAMES,
  HOST_EVENT_PAYLOAD_KEYS,
  isHostEventName,
} from './events'
export type {
  HostEventBus,
  HostEventBusOptions,
  HostEventErrorReporter,
  HostEventHandler,
  HostEventName,
  HostEventPayload,
  HostEventPayloadMap,
  HostEventSink,
  HostEventSource,
  JsonPrimitive,
  JsonRecord,
  JsonValue,
  McpStdioClosePayload,
  McpStdioToolsChangedPayload,
} from './events'

// model 域的**流式出口**：转发本身不进路由表。`HostInvoke` 的 `(cmd,args)=>Promise<T>` 装不下
// 一个流，而同一张表还要被 `/api/invoke/:command` 的 JSON 信封包住；写一个「攒完再返回」的
// handler 只会造出一个在开发机上看不出来的假象。所以 M2 的 SSE 端点直接调这个函数，
// 路由表里只留两条 cancel。设计与失败分界线见 src/model/forwardRequest.ts 的文件头。
export { forwardProviderRequest, modelRequestRegistry } from './model'
export { ModelProxyStreamError, ModelRequestCancelledError } from './model'
export type { ForwardedModelResponse } from './model'
