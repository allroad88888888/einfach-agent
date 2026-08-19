// events 域的公开面：宿主的**反向通道**
// ---------------------------------------------------------------------------
// 本域**没有命令**，因此没有 registrar，也不出现在 `commandNames.ts` 的 28 条里、
// 不进 `createNodeHostInvoke` 的路由表。它是一条独立导出面。
//
// 为什么必须独立：命令桥 `HostInvoke` 的签名是 `(cmd, args) => Promise<T>`——只能表达
// 「我问、宿主答」。而 MCP 子进程自己退出、它的工具清单变了，是**宿主主动发生**的事，
// 那个形状装不下。桌面侧对应的是 Rust `app.emit` + 前端 `listen`
// （`apps/desktop/src/mcp_lifecycle.rs` / `apps/web/src/mcp/tauriStdioConnector.ts`）。
//
// 三条下游线照抄本域的契约：
//   · C1  MCP stdio 传输层持 `HostEventSink`，进程退出/清单变化时 `emitHostEvent`。
//   · C3  `apps/server` 的 `GET /api/events` 持 `HostEventSource`，把事件编成 SSE 帧
//         （`event:` 放事件名，`data:` 放 `JSON.stringify(payload)`；收端用 `isHostEventName`
//         判名字，别 `as`）。载荷已由发射侧保证 JSON 往返不变形，见 `jsonPayload.ts`。
//   · T 线 Tauri 套壳起 sidecar，同样跨进程序列化，与 C3 同构。
//
// 装配（宿主启动时一次）：
//
//   import { createHostEventBus } from '@web-agent/host-node'
//   const hostEvents = createHostEventBus({ onHandlerError })
//   // 发射面交给 MCP 传输层（C1 会在 NodeHostInvokeOptions 上开这个槽）
//   // 订阅面交给 CLI 的直接消费方 / apps/server 的 SSE 端点
//
// 订阅面与发射面是**同一次创建的两半**，不能各造各的——理由见 `hostEventBus.ts` 文件头。

export { createHostEventBus } from './hostEventBus'
export type {
  HostEventBus,
  HostEventBusOptions,
  HostEventErrorReporter,
  HostEventHandler,
  HostEventSink,
  HostEventSource,
} from './hostEventBus'

export { HOST_EVENT_NAMES, isHostEventName } from './hostEventNames'
export type { HostEventName } from './hostEventNames'

export { HOST_EVENT_PAYLOAD_KEYS } from './hostEventPayloads'
export type {
  HostEventPayload,
  HostEventPayloadMap,
  McpStdioClosePayload,
  McpStdioToolsChangedPayload,
} from './hostEventPayloads'

// `JsonRecord` / `JsonValue` 一并导出：C3 编 SSE 帧、C4 解帧时都要在类型上表达
// 「这里只能是 JSON」，让它们各写一份等价定义就等于埋一个会漂移的第二权威。
export type { JsonPrimitive, JsonRecord, JsonValue } from './jsonPayload'
