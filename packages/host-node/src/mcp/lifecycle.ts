// 子进程生命周期事件：本卡只产事件，出口由 C2 提供
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_lifecycle.rs（已随 T1 删除）的**通知器**部分。Rust 那边的出口是
// `AppHandle::emit`（Tauri 的 webview 事件总线），前端用 `listen()` 收
// （apps/web/src/mcp/tauriStdioConnector.ts:217）。Node 侧没有那条总线，所以出口是注入的。
//
// ═══ 给 C2（`packages/host-node/src/events/`）的对接规格 ═══
//
// 本域需要的**只有一个东西**：一个「把事件送出去」的函数
//
//     type McpHostEventEmitter = (event: McpHostEvent) => void
//
// 由 `createMcpRoutes({ emitHostEvent })` 注入。不传 = 事件丢弃（等价 Rust 的
// `McpLifecycleEventSink::default()`，连接照常可用，只是外界收不到「工具变了」「连接掉了」）。
//
// 两个事件名与载荷**与 Rust emit 的逐字相同**，因为 C4 的 serverStdioConnector 要能原样复用
// tauriStdioConnector 的解析（它按 `serverId` + `sessionToken` 过滤，两个字段少一个就会把
// 迟到的旧会话事件误判成当前会话的）：
//
//     'mcp-stdio-tools-changed'  { serverId, sessionToken }
//     'mcp-stdio-close'          { serverId, sessionToken, message }
//
// C2 卡面写的是订阅侧 `onHostEvent(name, handler): () => void`。两者是同一条通道的两头：
// C2 只需把它的 emit 侧包成上面这个签名传进来即可，**本域不需要也不想拿到订阅面**——
// 传输层能订阅自己发出的事件，就等于给「靠事件回环驱动状态」留了口子。
//
// 【为什么不自己造一个 EventEmitter】那会变成第二套事件机制：C2 一落地，
// 「MCP 的事件」和「宿主的事件」就是两个互不相通的通道，而它们要送到的是同一个前端订阅点。

/** 事件名。字面量联合而不是 string——写错一个字母不该编译得过去。 */
export type McpHostEventName = 'mcp-stdio-tools-changed' | 'mcp-stdio-close'

export interface McpToolsChangedEvent {
  name: 'mcp-stdio-tools-changed'
  payload: { serverId: string; sessionToken: string }
}

export interface McpCloseEvent {
  name: 'mcp-stdio-close'
  payload: { serverId: string; sessionToken: string; message: string }
}

export type McpHostEvent = McpToolsChangedEvent | McpCloseEvent

/** C2 要提供的出口。同步调用，抛错由本模块吞掉（见 `emit`）。 */
export type McpHostEventEmitter = (event: McpHostEvent) => void

/**
 * 一个会话的事件通知器。
 *
 * 两条去重规则照搬 Rust，缺一条就会有可观测的错：
 *   · **正在主动关闭时一律闭嘴**（`closing`）。disconnect 会依次触发「stdin 关了 → 子进程退出
 *     → stdout EOF」，每一步都长得像一次意外掉线；不闭嘴的话，用户点一次「注销」会收到一条
 *     「连接意外断开」的告警。
 *   · **close 事件一个会话只发一次**（`closeEventSent`）。stdout EOF 与进程退出**必然**都会
 *     发生，且顺序不定，两条都发出去的话前端会走两遍「意外关闭」清理，第二遍作用在已经建立的
 *     新会话上（Rust 的测试 `stdout EOF and process exit must emit one close event` 钉的就是这条）。
 */
export class McpLifecycleNotifier {
  private closeEventSent = false

  constructor(
    private readonly serverId: string,
    private readonly sessionToken: string,
    private readonly emitEvent: McpHostEventEmitter,
    /** 会话是否正在被主动关闭。由 session 持有并翻转，这里只读。 */
    private readonly isClosing: () => boolean,
  ) {}

  toolsChanged(): void {
    if (this.isClosing() || this.closeEventSent) return
    this.emit({
      name: 'mcp-stdio-tools-changed',
      payload: { serverId: this.serverId, sessionToken: this.sessionToken },
    })
  }

  closed(message: string): void {
    if (this.isClosing() || this.closeEventSent) return
    this.closeEventSent = true
    this.emit({
      name: 'mcp-stdio-close',
      payload: { serverId: this.serverId, sessionToken: this.sessionToken, message },
    })
  }

  /**
   * 出口抛错不能掀翻调用点：`closed()` 是在 stdout EOF、进程退出这些**清理路径**上调的，
   * 那些地方一个异常会让后面的 fd 关闭与 pending 收尾整段不执行，症状就是本卡最忌讳的进程泄漏。
   * Rust 侧对 `app.emit` 的失败同样只 `log::warn!`。
   */
  private emit(event: McpHostEvent): void {
    try {
      this.emitEvent(event)
    } catch {
      // 出口自己的问题，与这条会话的清理无关。
    }
  }
}

/** 不传出口时的默认值：丢弃。等价 Rust 的 `McpLifecycleEventSink::default()`。 */
export const discardHostEvents: McpHostEventEmitter = () => {}
