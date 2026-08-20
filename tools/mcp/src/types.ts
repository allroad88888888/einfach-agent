import type { ToolRegistry } from '@einfach-agent/core/tools'
import type { Tool, ToolResult } from '@einfach-agent/core/tools'
import type { McpPlaceholderClaims } from './placeholderClaims'

interface McpServerConfigBase {
  /** Stable application-local key. It also namespaces registered tool names. */
  id: string
  /** Optional user-facing label. */
  name?: string
}

export interface McpStreamableHttpServerConfig extends McpServerConfigBase {
  transport: 'streamable-http'
  url: string
  headers?: Readonly<Record<string, string>>
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: 'stdio'
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}

export type McpServerConfig = McpStreamableHttpServerConfig | McpStdioServerConfig

/**
 * 「MCP 用哪种传输」的**唯一**定义面，全仓只此一处；应用层（apps/web/src/mcp）import 它，
 * 不再自己写一份同名联合。
 *
 * 【为什么派生而不是手写字面量联合】它必须恒等于 McpServerConfig 的判别式：新增一种传输就是
 * 往上面那个联合里加一个成员，派生写法让 McpTransport 自动跟上。手写一份的下场见这次统一
 * 之前——域包与应用层各存一份，加传输时漏改一处不报错，症状是「配置存得下、就是连不上」。
 */
export type McpTransport = McpServerConfig['transport']

export interface McpOperationOptions {
  signal?: AbortSignal
}

/** Protocol-neutral tool shape used by injected connectors and tests. */
export interface McpRemoteTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  [key: string]: unknown
}

/** Protocol-neutral call result. Concrete connectors may retain extra MCP fields. */
export interface McpCallToolResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export type McpConnectionCloseListener = (error?: Error) => void
export type McpToolsChangedListener = () => void | Promise<void>

/**
 * A live MCP session. Keeping this interface independent from the official SDK
 * lets browser HTTP and host-native stdio transports share one manager.
 */
export interface McpConnection {
  listTools(options?: McpOperationOptions): Promise<readonly McpRemoteTool[]>
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpOperationOptions,
  ): Promise<McpCallToolResult>
  onToolsChanged(listener: McpToolsChangedListener): () => void
  onClose(listener: McpConnectionCloseListener): () => void
  close(): Promise<void>
  /**
   * 【可选】轻量探活：只回答「这条连接还活着吗」，不产生任何其它效果。对应 MCP 协议的
   * ping 请求（JSON-RPC method `"ping"`，响应是空对象）。给保活探测用，见 keepaliveMonitor.ts。
   *
   * 为什么不拿 listTools 当心跳：listTools 的语义是「给我全量工具清单」，代价随工具数线性
   * 增长（本包的硬上限是 100 页 / 1000 个工具），而且调用方拿到清单后几乎必然顺手对账 ——
   * 于是每次心跳都要重算整份 registry 的增删改，连「工具名冲突」这种与连接死活无关的失败
   * 都会被当成断线。心跳和对账是两件事。
   *
   * 【可选】是刻意的：不实现它的传输就不会被探活（monitor 只对实现了 ping 的连接起表），
   * 绝不退化成用 listTools 顶替。stdio 可以不实现 —— 子进程退出、管道关闭是 OS 级的确定
   * 信号，会直接走 onClose；静默死亡（NAT 超时、代理掐断、对端重启后没通知）是 HTTP/SSE 的病。
   */
  ping?(options?: McpOperationOptions): Promise<void>
}

export interface McpConnector {
  connect(config: McpServerConfig, options?: McpOperationOptions): Promise<McpConnection>
}

/**
 * - 'connecting' / 'reconnecting': a (re)connect attempt is in flight, or a
 *   temporary failure was just classified and is safe to retry (the actual
 *   retry scheduling is not implemented here; see failureClassification.ts).
 * - 'error': a permanent failure — auth rejected, invalid URL/config, command
 *   not found/unexecutable, tool-count/name limits, or an unsupported
 *   capability declaration. Retrying without a config/environment fix will
 *   not help.
 *
 * See classifyMcpFailure() in failureClassification.ts for the exact rules
 * that decide between 'reconnecting' and 'error'.
 */
export type McpServerStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error'

export interface McpToolSnapshot {
  /** ToolRegistry name exposed to the model. */
  name: string
  remoteName: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerSnapshot {
  id: string
  config: McpServerConfig
  status: McpServerStatus
  tools: readonly McpToolSnapshot[]
  error?: string
}

export type McpClientManagerListener = (servers: readonly McpServerSnapshot[]) => void

export interface McpClientManagerOptions {
  registry: ToolRegistry
  /**
   * Replaces the default Streamable HTTP connector. Use
   * createMcpConnectorRouter() to combine HTTP and host-native stdio.
   */
  connector?: McpConnector
  /**
   * 占位工具登记表，原样透传给每次 reconcile。
   *
   * 必须与占位同步器（placeholderSync.ts）用【同一个实例】：reconcile 靠它放行「本服务占位
   * 正占着这个名字」，否则每个有缓存清单的服务一连接就抛工具名冲突。不接这根线 = 系统里
   * 没有占位，连接行为与占位上线前逐字节一致。
   */
  placeholders?: McpPlaceholderClaims
}

export interface McpRegisteredTool {
  tool: Tool
  snapshot: McpToolSnapshot
}

export type McpNormalizedToolResult = ToolResult
