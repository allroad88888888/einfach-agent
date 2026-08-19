// server 宿主的 MCP stdio connector：浏览器 + 本机 Node 后端（`apps/server`）。
// ---------------------------------------------------------------------------
// `tauriStdioConnector.ts` 的同接口替身。`McpConnector` / `McpConnection` 两个契约一字不改，
// 于是 `tools/mcp` 那 5000 多行协议编排（工具适配、schema 校验、集合对账、退避重连、失败分类、
// 清单缓存）在两个宿主上跑的是同一份代码——本文件只回答「怎么连上本机 Node 后端」。
//
// ═══ 与 Tauri 版的三处结构差异，都源于传输 ═══
//
// ① **生命周期事件是一条共享的 SSE 连接**（`serverHostEventStream.ts`），不是每条会话各挂两个
//    `listen()`。所以事件路由在本文件：一帧进来，按 `(serverId, sessionToken)` 分给对应会话
//    （过滤判据本身照抄，在 `serverStdioConnection.ts`）。连接开在第一条会话建立时、
//    收在最后一条会话注销时——与 Tauri 的 listen/unlisten 生命周期等价。
// ② **订阅是同步的**。Tauri 的 `listen()` 是 async，那份代码因此要在两次 listen 之间复查
//    `assertOpen()`（防止 await 期间连接已被关掉）。这里 `subscribe()` 同步返回，那个窗口
//    结构上不存在，复查也就没有对象。
// ③ **多了重连补偿**。C3 明确不保证重连不丢事件（不发 `id:`、不留重放缓冲），补偿归客户端：
//    每次（含第一次）连上事件流之后，对每个已建立的会话重拉一次 `mcp_list_tools`，
//    拉不到的按已关闭处理。这条是 C3 交回时点名「必须做」的判据。

import {
  type McpConnection,
  type McpConnector,
  type McpOperationOptions,
  type McpServerConfig,
} from '@einfach-agent/tools-mcp'
import {
  createServerHostEventStream,
  type ServerHostEvent,
  type ServerHostEventStream,
  type ServerHostEventStreamOptions,
} from './serverHostEventStream'
import {
  abortable,
  bestEffortDisconnect,
  CONNECT_TIMEOUT_MS,
  invokeMcp,
  throwIfAborted,
  toError,
} from './serverMcpCommands'
import { ServerStdioMcpConnection } from './serverStdioConnection'

interface ServerConnectResult {
  serverId?: unknown
  sessionToken?: unknown
}

let fallbackSessionSequence = 0

/** 与 Tauri 版逐字相同：`crypto.randomUUID` 不可用时退到时间 + 序号 + 随机数。 */
function createSessionToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid

  fallbackSessionSequence += 1
  return [
    Date.now().toString(36),
    fallbackSessionSequence.toString(36),
    Math.random().toString(36).slice(2),
  ].join('-')
}

export interface ServerStdioMcpConnectorOptions {
  /** 事件流的可替换依赖（fetch / token 环境 / 退避 / 失败去处）。生产不必传。 */
  readonly events?: ServerHostEventStreamOptions
}

export class ServerStdioMcpConnector implements McpConnector {
  private readonly stream: ServerHostEventStream
  private readonly connections = new Set<ServerStdioMcpConnection>()
  private unsubscribe: (() => void) | undefined

  constructor(options: ServerStdioMcpConnectorOptions = {}) {
    this.stream = createServerHostEventStream(options.events)
  }

  async connect(
    config: McpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpConnection> {
    if (config.transport !== 'stdio') {
      throw new Error(`本机服务 stdio connector 不支持传输：${config.transport}`)
    }
    throwIfAborted(options?.signal)

    const sessionToken = createSessionToken()
    const connection = new ServerStdioMcpConnection(
      config.id,
      sessionToken,
      () => { this.forget(connection) },
    )
    let connectedOnHost = false

    // **先上事件路由，再发 connect**（同 Tauri 版的先 listen 后 invoke）：子进程有可能在
    // `mcp_connect` 的回执到达之前就死掉，那条 close 事件必须有人接。
    this.attach(connection)
    try {
      throwIfAborted(options?.signal)

      const result = await abortable(
        invokeMcp<ServerConnectResult>('mcp_connect', {
          serverId: config.id,
          sessionToken,
          command: config.command,
          args: [...(config.args ?? [])],
          ...(config.cwd ? { cwd: config.cwd } : {}),
          ...(config.env ? { env: { ...config.env } } : {}),
          requestTimeoutMs: CONNECT_TIMEOUT_MS,
          clientInfo: {
            name: 'einfach-agent',
            version: '0.1.0',
            title: 'Einfach Agent',
          },
        }),
        options?.signal,
        () => bestEffortDisconnect(config.id, sessionToken),
      )
      connectedOnHost = true
      if (result.serverId !== config.id || result.sessionToken !== sessionToken) {
        throw new Error(`MCP 连接返回了不匹配的会话标识：${config.id}`)
      }
      throwIfAborted(options?.signal)
      connection.assertConnected()
      connection.markEstablished()
      return connection
    } catch (error) {
      connection.disposeLifecycleEvents()
      if (connectedOnHost) {
        await bestEffortDisconnect(config.id, sessionToken)
      }
      throw toError(error)
    }
  }

  private attach(connection: ServerStdioMcpConnection): void {
    this.connections.add(connection)
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.stream.subscribe({
      onEvent: (event) => { this.routeEvent(event) },
      // 补偿是异步的，而订阅面是同步回调：这里刻意 `void`，让事件流自己的读取循环不被
      // 一次 `mcp_list_tools` 往返卡住。`resyncAfterStreamConnected()` 自己不会 reject。
      onStreamConnected: () => { void this.resyncAll() },
    })
  }

  private forget(connection: ServerStdioMcpConnection): void {
    this.connections.delete(connection)
    if (this.connections.size > 0 || this.unsubscribe === undefined) return
    // 最后一条会话走了：把共享连接也收掉，别让一条没有消费方的 SSE 长连接挂在服务端
    // 并永远重连下去。下一次 connect 会重新开一条。
    this.unsubscribe()
    this.unsubscribe = undefined
  }

  private routeEvent(event: ServerHostEvent): void {
    // 全局广播 + 消费方自己过滤，与 Rust `app.emit` 同形状（host-node 的事件面刻意不做
    // 按 serverId 的路由，就是为了让两个宿主的过滤逻辑能逐字照搬）。
    for (const connection of [...this.connections]) {
      if (event.name === 'mcp-stdio-close') connection.handleCloseEvent(event.payload)
      else connection.handleToolsChangedEvent(event.payload)
    }
  }

  private async resyncAll(): Promise<void> {
    await Promise.all(
      [...this.connections].map((connection) => connection.resyncAfterStreamConnected()),
    )
  }
}

export function createServerStdioMcpConnector(
  options: ServerStdioMcpConnectorOptions = {},
): McpConnector {
  return new ServerStdioMcpConnector(options)
}
