import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  McpCallToolResult,
  McpConnection,
  McpConnectionCloseListener,
  McpConnector,
  McpOperationOptions,
  McpRemoteTool,
  McpServerConfig,
  McpToolsChangedListener,
} from '@web-agent/tools-mcp'

const CONNECT_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 60_000
const MCP_STDIO_TOOLS_CHANGED_EVENT = 'mcp-stdio-tools-changed'
const MCP_STDIO_CLOSE_EVENT = 'mcp-stdio-close'

let fallbackSessionSequence = 0

interface TauriMcpError {
  kind?: string
  message?: string
  serverId?: string
  rpcCode?: number
  data?: unknown
}

interface TauriConnectResult {
  serverId?: unknown
  sessionToken?: unknown
}

interface TauriListToolsResult {
  tools?: unknown
  truncated?: boolean
}

interface TauriCallToolResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

interface TauriLifecycleEventPayload {
  serverId: string
  sessionToken: string
}

interface TauriCloseEventPayload extends TauriLifecycleEventPayload {
  message?: string
}

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

function abortError(): DOMException {
  return new DOMException('MCP 操作已取消', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/**
 * Tauri invoke cannot cancel an in-flight Rust command. This wrapper still
 * settles the caller immediately and consumes the late command result so it
 * cannot become an unhandled rejection.
 */
function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onLateSuccess?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.then(onLateSuccess, () => {})
    return Promise.reject(abortError())
  }

  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = () => {
      aborted = true
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (aborted) {
          void onLateSuccess?.(value)
          return
        }
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        if (!aborted) reject(error)
      },
    )
  })
}

function asTauriError(value: unknown): TauriMcpError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as TauriMcpError
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (
    value
    && typeof value === 'object'
    && 'name' in value
    && value.name === 'AbortError'
  ) {
    return abortError()
  }
  const remote = asTauriError(value)
  if (remote?.message) {
    return new Error(remote.message)
  }
  return new Error(typeof value === 'string' ? value : 'Tauri MCP 调用失败')
}

function isFatalConnectionError(value: unknown): boolean {
  const kind = asTauriError(value)?.kind
  return kind === 'not_connected'
    || kind === 'stale_session'
    || kind === 'process_exited'
    || kind === 'transport_closed'
    || kind === 'transport_error'
    || kind === 'process_error'
    || kind === 'worker_failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeTool(value: unknown): McpRemoteTool {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('MCP tools/list 返回了名称无效的工具')
  }
  if (!isRecord(value.inputSchema)) {
    throw new Error(
      `MCP 工具 "${value.name.slice(0, 120)}" 的 inputSchema 必须是对象`,
    )
  }
  return {
    ...value,
    name: value.name,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    inputSchema: value.inputSchema,
    ...(isRecord(value.annotations) ? { annotations: value.annotations } : {}),
  }
}

function isLifecycleEventForSession(
  value: unknown,
  serverId: string,
  sessionToken: string,
): value is TauriLifecycleEventPayload {
  return isRecord(value)
    && value.serverId === serverId
    && value.sessionToken === sessionToken
}

async function bestEffortDisconnect(
  serverId: string,
  sessionToken: string,
): Promise<void> {
  try {
    await invoke('mcp_disconnect', {
      input: { serverId, sessionToken, gracePeriodMs: 500 },
    })
  } catch {
    // A late connect may already have failed or the host may already be gone.
  }
}

class TauriStdioMcpConnection implements McpConnection {
  private closed = false
  private closeError: Error | undefined
  private closePromise: Promise<void> | undefined
  private readonly lifecycleUnlisteners: UnlistenFn[] = []
  private readonly closeListeners = new Set<McpConnectionCloseListener>()
  private readonly toolsChangedListeners = new Set<McpToolsChangedListener>()

  constructor(
    private readonly serverId: string,
    private readonly sessionToken: string,
  ) {}

  async listenForLifecycleEvents(): Promise<void> {
    const registered: UnlistenFn[] = []
    try {
      registered.push(await listen<unknown>(
        MCP_STDIO_TOOLS_CHANGED_EVENT,
        ({ payload }) => this.handleToolsChangedEvent(payload),
      ))
      this.assertOpen()
      registered.push(await listen<unknown>(
        MCP_STDIO_CLOSE_EVENT,
        ({ payload }) => this.handleCloseEvent(payload),
      ))
      this.assertOpen()
      this.lifecycleUnlisteners.push(...registered)
    } catch (error) {
      for (const unlisten of registered) {
        try {
          unlisten()
        } catch {
          // Best effort: a failed listen must not leak any earlier subscription.
        }
      }
      throw error
    }
  }

  disposeLifecycleEvents(): void {
    for (const unlisten of this.lifecycleUnlisteners.splice(0)) {
      try {
        unlisten()
      } catch {
        // Tauri unlisten is local cleanup; continue removing the other handler.
      }
    }
  }

  assertConnected(): void {
    this.assertOpen()
  }

  async listTools(options?: McpOperationOptions): Promise<readonly McpRemoteTool[]> {
    this.assertOpen()
    throwIfAborted(options?.signal)
    try {
      const result = await abortable(
        invoke<TauriListToolsResult>('mcp_list_tools', {
          input: {
            serverId: this.serverId,
            sessionToken: this.sessionToken,
            allPages: true,
            timeoutMs: LIST_TIMEOUT_MS,
          },
        }),
        options?.signal,
      )
      if (result.truncated) {
        throw new Error('MCP tools/list 超过桌面端分页上限')
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
        invoke<TauriCallToolResult>('mcp_call_tool', {
          input: {
            serverId: this.serverId,
            sessionToken: this.sessionToken,
            name,
            arguments: args,
            timeoutMs: CALL_TIMEOUT_MS,
          },
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

  private assertOpen(): void {
    if (this.closeError) throw this.closeError
    if (this.closed) throw new Error(`MCP 服务已注销：${this.serverId}`)
  }

  private handleOperationError(value: unknown): void {
    if (!isFatalConnectionError(value) || this.closed) return
    this.markUnexpectedClosed(toError(value))
  }

  private handleToolsChangedEvent(payload: unknown): void {
    if (
      this.closed
      || !isLifecycleEventForSession(payload, this.serverId, this.sessionToken)
    ) {
      return
    }

    for (const listener of [...this.toolsChangedListeners]) {
      try {
        void Promise.resolve(listener()).catch(() => undefined)
      } catch {
        // A manager callback owns its own failure handling.
      }
    }
  }

  private handleCloseEvent(payload: unknown): void {
    if (
      this.closed
      || !isLifecycleEventForSession(payload, this.serverId, this.sessionToken)
    ) {
      return
    }
    const message = typeof (payload as TauriCloseEventPayload).message === 'string'
      ? (payload as TauriCloseEventPayload).message
      : `MCP server transport closed unexpectedly: ${this.serverId}`
    this.markUnexpectedClosed(new Error(message))
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
      await invoke('mcp_disconnect', {
        input: {
          serverId: this.serverId,
          sessionToken: this.sessionToken,
          gracePeriodMs: 1_000,
        },
      })
    } catch (error) {
      const kind = asTauriError(error)?.kind
      if (kind !== 'not_connected' && kind !== 'stale_session') {
        throw toError(error)
      }
    } finally {
      this.closeListeners.clear()
      this.toolsChangedListeners.clear()
    }
  }
}

export class TauriStdioMcpConnector implements McpConnector {
  async connect(
    config: McpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpConnection> {
    if (config.transport !== 'stdio') {
      throw new Error(`Tauri stdio connector 不支持传输：${config.transport}`)
    }
    throwIfAborted(options?.signal)

    const sessionToken = createSessionToken()
    const connection = new TauriStdioMcpConnection(config.id, sessionToken)
    let connectedOnHost = false

    try {
      await connection.listenForLifecycleEvents()
      throwIfAborted(options?.signal)

      const result = await abortable(
        invoke<TauriConnectResult>('mcp_connect', {
          input: {
            serverId: config.id,
            sessionToken,
            command: config.command,
            args: [...(config.args ?? [])],
            ...(config.cwd ? { cwd: config.cwd } : {}),
            ...(config.env ? { env: { ...config.env } } : {}),
            requestTimeoutMs: CONNECT_TIMEOUT_MS,
            clientInfo: {
              name: 'web-agent',
              version: '0.1.0',
              title: 'Web Agent',
            },
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
      return connection
    } catch (error) {
      connection.disposeLifecycleEvents()
      if (connectedOnHost) {
        await bestEffortDisconnect(config.id, sessionToken)
      }
      throw toError(error)
    }
  }
}

export function createTauriStdioMcpConnector(): McpConnector {
  return new TauriStdioMcpConnector()
}
