// 一条经本机 Node 服务建立的 MCP stdio 会话（`McpConnection` 的 server 宿主实现）。
// ---------------------------------------------------------------------------
// **状态机与 `tauriStdioConnector.ts` 里的 `TauriStdioMcpConnection` 逐字对应**：closed /
// closeError 两个闸、两组监听器、`markUnexpectedClosed` 的一次性语义、`close()` 的幂等
// promise、`disconnect()` 对 `not_connected` / `stale_session` 的容忍——一个字都没改。
// 与那份的差别只有两处，都源于传输：
//
//   ① **生命周期事件不是自己订阅的**。Tauri 那边每条连接各 `listen()` 两次；这里是
//      `serverStdioConnector.ts` 持一条共享 SSE 连接，把帧解析出来再按
//      `(serverId, sessionToken)` 分给对应的会话。所以本文件收的是 `detach`（把自己从
//      那张路由表上摘掉），而不是两个 unlisten。过滤判据本身照抄，见 `isEventForThisSession`。
//   ② 多一个 `resyncAfterStreamConnected()`。C3 明确不保证重连不丢事件，补偿动作由客户端做：
//      每次（含第一次）连上事件流之后，对每个自认还活着的会话重拉一次 `mcp_list_tools`，
//      拉不到的按已关闭处理。理由见 `serverHostEventStream.ts` 文件头。

import {
  type McpCallToolResult,
  type McpConnection,
  type McpConnectionCloseListener,
  type McpOperationOptions,
  type McpRemoteTool,
  type McpToolsChangedListener,
} from '@einfach-agent/tools-mcp'
import {
  abortable,
  CALL_TIMEOUT_MS,
  invokeMcp,
  isFatalConnectionError,
  LIST_TIMEOUT_MS,
  mcpFailureKind,
  normalizeTool,
  throwIfAborted,
  toError,
} from './serverMcpCommands'

interface ServerListToolsResult {
  tools?: unknown
  truncated?: boolean
}

interface ServerCallToolResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * 事件的归属判定，与 `tauriStdioConnector.ts` 的 `isLifecycleEventForSession` 逐字同判据。
 * 两侧都得能照抄，所以 host-node 的事件面刻意保持 Rust `app.emit` 的全局广播形状
 * （不按 serverId 路由）——见 `packages/host-node/src/events/hostEventPayloads.ts` 的记档。
 * `sessionToken` 是关键：同一个 serverId 重连之后是新会话，旧连接必须认出「这条不是我的」。
 */
function isEventForThisSession(
  payload: Record<string, unknown>,
  serverId: string,
  sessionToken: string,
): boolean {
  return payload.serverId === serverId && payload.sessionToken === sessionToken
}

export class ServerStdioMcpConnection implements McpConnection {
  private closed = false
  private closeError: Error | undefined
  private closePromise: Promise<void> | undefined
  private established = false
  private detached = false
  private readonly closeListeners = new Set<McpConnectionCloseListener>()
  private readonly toolsChangedListeners = new Set<McpToolsChangedListener>()

  constructor(
    private readonly serverId: string,
    private readonly sessionToken: string,
    /** 把自己从连接器的事件路由表上摘掉。幂等由本类保证。 */
    private readonly detach: () => void,
  ) {}

  /** 连接器在 `mcp_connect` 成功之后调：在此之前本会话不参与重连补偿（它自己就在建立中）。 */
  markEstablished(): void {
    this.established = true
  }

  disposeLifecycleEvents(): void {
    if (this.detached) return
    this.detached = true
    this.detach()
  }

  assertConnected(): void {
    this.assertOpen()
  }

  async listTools(options?: McpOperationOptions): Promise<readonly McpRemoteTool[]> {
    this.assertOpen()
    throwIfAborted(options?.signal)
    try {
      const result = await abortable(
        invokeMcp<ServerListToolsResult>('mcp_list_tools', {
          serverId: this.serverId,
          sessionToken: this.sessionToken,
          allPages: true,
          timeoutMs: LIST_TIMEOUT_MS,
        }),
        options?.signal,
      )
      if (result.truncated) {
        // Tauri 版这句写的是「超过桌面端分页上限」。上限本身是同一个（host-node 的
        // `mcp/limits.ts` 等价移植自 `mcp_limits.rs`，逐值相同），但这条路上根本没有桌面端，
        // 照抄会给用户一句指错方向的话。分类器不读中文文案（`failureClassification.ts` 的
        // 规则全是英文 pattern），所以改这几个字不影响任何判定。
        throw new Error('MCP tools/list 超过本机服务分页上限')
      }
      return Array.isArray(result.tools)
        ? result.tools.map(normalizeTool)
        : []
    } catch (error) {
      this.handleOperationError(error)
      throw toError(error)
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpOperationOptions,
  ): Promise<McpCallToolResult> {
    this.assertOpen()
    throwIfAborted(options?.signal)
    try {
      const result = await abortable(
        invokeMcp<ServerCallToolResult>('mcp_call_tool', {
          serverId: this.serverId,
          sessionToken: this.sessionToken,
          name,
          arguments: args,
          timeoutMs: CALL_TIMEOUT_MS,
        }),
        options?.signal,
      )
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError === true,
        ...(result._meta ? { _meta: result._meta } : {}),
      }
    } catch (error) {
      this.handleOperationError(error)
      throw toError(error)
    }
  }

  onToolsChanged(listener: McpToolsChangedListener): () => void {
    if (this.closed) return () => {}
    this.toolsChangedListeners.add(listener)
    return () => this.toolsChangedListeners.delete(listener)
  }

  onClose(listener: McpConnectionCloseListener): () => void {
    if (this.closeError) {
      try {
        listener(this.closeError)
      } catch {
        // Connection observers must not break connector cleanup.
      }
      return () => {}
    }
    if (this.closed) return () => {}
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.disposeLifecycleEvents()
    this.closePromise = this.disconnect()
    return this.closePromise
  }

  /**
   * 事件流（重)连成功后的补偿：重新确定这条会话还在不在。
   *
   * **拉不到就按已关闭处理**——断线期间子进程可能已经退出，而那条 close 事件我们没收到
   * （C3 不留重放缓冲，理由是重放一条旧 close 可能拆掉此后已重连好的会话）。
   * 拉得到就报一次 `toolsChanged`：断线期间对端可能发过 list_changed，而我们同样收不到，
   * 所以不能假定清单没变。这与收到一条真事件之后要做的事完全相同，不是额外负担。
   */
  async resyncAfterStreamConnected(): Promise<void> {
    if (!this.established || this.closed) return
    try {
      await this.listTools()
    } catch (error) {
      this.markUnexpectedClosed(toError(error))
      return
    }
    this.notifyToolsChanged()
  }

  handleToolsChangedEvent(payload: Record<string, unknown>): void {
    if (this.closed || !isEventForThisSession(payload, this.serverId, this.sessionToken)) return
    this.notifyToolsChanged()
  }

  handleCloseEvent(payload: Record<string, unknown>): void {
    if (this.closed || !isEventForThisSession(payload, this.serverId, this.sessionToken)) return
    // 兜底文案保留（同 Tauri 版）：发射方按契约恒带 message，这是消费方的防御，不是契约变松。
    const message = typeof payload.message === 'string'
      ? payload.message
      : `MCP server transport closed unexpectedly: ${this.serverId}`
    this.markUnexpectedClosed(new Error(message))
  }

  private assertOpen(): void {
    if (this.closeError) throw this.closeError
    if (this.closed) throw new Error(`MCP 服务已注销：${this.serverId}`)
  }

  private handleOperationError(value: unknown): void {
    if (!isFatalConnectionError(value) || this.closed) return
    this.markUnexpectedClosed(toError(value))
  }

  private notifyToolsChanged(): void {
    for (const listener of [...this.toolsChangedListeners]) {
      try {
        void Promise.resolve(listener()).catch(() => undefined)
      } catch {
        // A manager callback owns its own failure handling.
      }
    }
  }

  private markUnexpectedClosed(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    this.disposeLifecycleEvents()
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error)
      } catch {
        // Connection observers must not break connector cleanup.
      }
    }
    this.closeListeners.clear()
    this.toolsChangedListeners.clear()
  }

  private async disconnect(): Promise<void> {
    try {
      await invokeMcp('mcp_disconnect', {
        serverId: this.serverId,
        sessionToken: this.sessionToken,
        gracePeriodMs: 1_000,
      })
    } catch (error) {
      // 只容忍这两个 kind，**不复用 `isFatalConnectionError` 那张七项表**（同 Tauri 版）：
      // 并过去会让「注销一个已退出的会话算成功」悄悄扩大成「传输崩了的会话也算注销成功」。
      const kind = mcpFailureKind(error)
      if (kind !== 'not_connected' && kind !== 'stale_session') {
        throw toError(error)
      }
    } finally {
      this.closeListeners.clear()
      this.toolsChangedListeners.clear()
    }
  }
}
