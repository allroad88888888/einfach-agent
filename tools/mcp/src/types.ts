import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { Tool, ToolResult } from '@web-agent/core/tools/types'

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
}

export interface McpRegisteredTool {
  tool: Tool
  snapshot: McpToolSnapshot
}

export type McpNormalizedToolResult = ToolResult
