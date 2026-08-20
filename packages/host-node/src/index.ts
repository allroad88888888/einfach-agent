// @einfach-agent/host-node —— Node 侧的宿主能力实现（core 命令桥的一种）
// ---------------------------------------------------------------------------
// 公开面只有三组：装配入口、命令全集、类型契约。域实现（`config/` 及后续的 `workspace/`
// `shell/` `mcp/` …）**不出现在这里**——它们是路由表的零件，对外只经
// `createNodeHostInvoke` 一个入口生效，单独暴露只会多出一条要维护的公开面。
//
// 典型装配（宿主启动时一次，早于任何工具可能执行的时点）：
//
//   import { configureHostInvoke } from '@einfach-agent/core'
//   import { createNodeHostInvoke } from '@einfach-agent/host-node'
//   const invoke = createNodeHostInvoke({})
//   configureHostInvoke(() => Promise.resolve(invoke))
//
// core 收的是 loader 而不是已解析的 invoke，理由见 runtime/hostBridge.ts：登记要同步生效，
// 否则 `hasHostBridge()` 会有一段为 false 的窗口，工具在那段时间跑会报「宿主不支持」。
//
// ═══ 关于本包注释里那一百多处 `apps/desktop/src/*.rs` ═══
// **那些文件已经不存在了。** 本包的绝大部分实现是 W 线从桌面端的 Rust 宿主**等价移植**过来的，
// 每个文件头都标着它移植自哪一份 Rust 源码；桌面端随 T1（提交 `e52c31d`）整条删除，那 16535 行
// Rust 只能从 Git 历史读。
//
// 所以这些引用**一律读作「移植出处」，不是「去那里对一下」**：本包今天是这批能力在本仓库的
// **唯一**实现，没有第二侧可比。凡是注释里写着「以 Rust 为准」「该改的是 Rust 侧」「Rust 侧改名
// 这里会当场红」的地方，都已经就地改正——若还剩下没改到的，按本段处理，不要照着去找那个文件。
// 移植时刻意保留的形状（snake_case 的结果键、错误文案里的英文原文、常量数值）仍然照搬未改：
// 它们当年的理由是跨语言对拍，今天的理由是**这就是这条命令的对外契约**，前端与 core 按它写死。

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

// sqlite 域：Node 侧的 SQL 执行面，实现 core 的 `SqlExecutor`（P1 的 port）。
// **这两条命令名是 Node 侧新定的**，没有移植来源：桌面端的等价能力由 Tauri 的 SQL **插件**提供，
// 从来不在它的命令表里（见 commandNames.ts 的 `DOMAINS_WITHOUT_DESKTOP_COMMANDS`）。
export {
  closeSqliteConnections,
  createNodeSqlExecutorLoader,
  isSqliteConnectionName,
  resolveSqliteDatabasePath,
  SQLITE_CONNECTION_NAMES,
} from './sqlite'
export type { SqliteConnectionName, SqliteRoutesOptions } from './sqlite'

// model 域失败的**判别面**（M6）。M2 要把「响应头之前的失败」分成 400/403/409/500/502/503，
// 而唯一能长期站住的判据是 `reason` 字段——文案是给人看的、会被改措辞，按它 switch 等于给一份
// 跨宿主对外契约立第二个权威（那正是 `NodeHostCommandErrorReason` 立下的规矩要避免的）。
// 只出 reason 面，**不出文案表**：`MODEL_ERROR` 留在包内，外壳拿不到就不会拿它做分支。
export { MODEL_REQUEST_ERROR_REASONS, readModelRequestErrorReason } from './model'
export type { ModelRequestErrorReason } from './model'

// mcp 域失败的**判别面**（C6）。与上面 model 域那条同款、同理由：`POST /api/invoke/:command`
// 要把「命令自己失败了」翻成一条带结构化标识的响应，而 MCP 那一支的标识就是 `kind`
// ——判别只看字段、不看类型身份，所以经 `toJSON()` 序列化之后仍然成立。同样**只出读取面**，
// `McpCommandError` 的构造与文案留在包内：外壳的活是转发这个标识，不是自己造一个。
//
// `readMcpFailureVerdict` 是同一条路上的第二样东西：「这次失败原样重试还有没有意义」。它同样只
// 由本包判（输入只有 kind，一个字都不读 message），外壳只负责把它放进失败信封带给客户端——
// 客户端从此不再自己维护一张 kind 表。判据与铁律见 `mcp/failureKinds.ts` 文件头。
export { readMcpCommandErrorKind } from './mcp/errors'
export { readMcpFailureVerdict } from './mcp/failureKinds'
export type { McpFailureReason, McpFailureVerdict } from './mcp/failureKinds'
