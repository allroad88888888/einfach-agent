import type { ToolRuntime } from '@web-agent/core/tools/types'
import {
  MCP_SERVER_MAX_TOOLS,
  combineAbortSignals,
  errorMessage,
  throwIfAborted,
  toError,
} from './internal'
import { createStreamableHttpMcpConnector } from './streamableHttp'
import { cloneMcpInputSchema, createMcpToolAdapter } from './toolAdapter'
import type {
  McpClientManagerListener,
  McpClientManagerOptions,
  McpConnection,
  McpConnector,
  McpOperationOptions,
  McpRegisteredTool,
  McpServerConfig,
  McpServerSnapshot,
  McpServerStatus,
  McpToolSnapshot,
} from './types'

interface McpServerRecord {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  connection?: McpConnection
  unsubscribeToolsChanged?: () => void
  unsubscribeClose?: () => void
  registered: Map<string, McpRegisteredTool>
}

interface McpToolsRefresh {
  connection: McpConnection
  controller: AbortController
  dirty: boolean
}

function cloneConfig(config: McpServerConfig): McpServerConfig {
  if (config.transport === 'streamable-http') {
    return {
      ...config,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    }
  }
  return {
    ...config,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
  }
}

function cloneToolSnapshot(snapshot: McpToolSnapshot): McpToolSnapshot {
  return {
    ...snapshot,
    inputSchema: cloneMcpInputSchema(snapshot.inputSchema),
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (
    !left
    || !right
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key)
        && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
}

function canReuseRegisteredTool(
  previous: McpRegisteredTool,
  next: McpRegisteredTool,
): boolean {
  return previous.snapshot.remoteName === next.snapshot.remoteName
    && previous.tool.name === next.tool.name
    && previous.tool.runtime === next.tool.runtime
    && previous.tool.skill.description === next.tool.skill.description
    && previous.tool.skill.content === next.tool.skill.content
    && sameJsonValue(previous.tool.inputSchema, next.tool.inputSchema)
    && sameJsonValue(previous.tool.execution, next.tool.execution)
}

function validateConfig(config: McpServerConfig): void {
  if (!config.id || !config.id.trim()) {
    throw new Error('MCP server id must not be empty')
  }

  if (config.transport === 'streamable-http') {
    const url = new URL(config.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`MCP Streamable HTTP URL must use http or https: ${config.url}`)
    }
    return
  }

  if (config.transport === 'stdio') {
    if (!config.command || !config.command.trim()) {
      throw new Error('MCP stdio command must not be empty')
    }
    return
  }

  const exhaustive: never = config
  throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`)
}

function runtimeFor(config: McpServerConfig): ToolRuntime {
  return config.transport === 'stdio' ? 'server' : 'internal'
}

/**
 * Owns MCP connections and reconciles their remote tools into one ToolRegistry.
 *
 * Operations are serialized per server. Transport callbacks are generation-safe
 * through connection identity checks, so an old close/list_changed event cannot
 * mutate a newer connection.
 */
export class McpClientManager {
  private readonly registry: McpClientManagerOptions['registry']
  private readonly connector: McpConnector
  private readonly records = new Map<string, McpServerRecord>()
  private readonly listeners = new Set<McpClientManagerListener>()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly activeConnects = new Map<string, AbortController>()
  private readonly toolsRefreshes = new Map<string, McpToolsRefresh>()

  constructor(options: McpClientManagerOptions) {
    this.registry = options.registry
    this.connector = options.connector ?? createStreamableHttpMcpConnector()
  }

  connect(
    config: McpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpServerSnapshot> {
    const ownedConfig = cloneConfig(config)
    validateConfig(ownedConfig)
    const controller = this.replaceConnectController(ownedConfig.id)

    return this.serialize(ownedConfig.id, async () => {
      const combined = combineAbortSignals(options?.signal, controller.signal)
      try {
        return await this.connectInternal(ownedConfig, 'connecting', {
          signal: combined.signal,
        })
      } finally {
        combined.dispose()
        this.releaseConnectController(ownedConfig.id, controller)
      }
    })
  }

  reconnect(
    serverId: string,
    options?: McpOperationOptions,
  ): Promise<McpServerSnapshot> {
    const controller = this.replaceConnectController(serverId)
    return this.serialize(serverId, async () => {
      const combined = combineAbortSignals(options?.signal, controller.signal)
      try {
        const record = this.records.get(serverId)
        if (!record) {
          throw new Error(`Unknown MCP server: ${serverId}`)
        }
        return await this.connectInternal(cloneConfig(record.config), 'reconnecting', {
          signal: combined.signal,
        })
      } finally {
        combined.dispose()
        this.releaseConnectController(serverId, controller)
      }
    })
  }

  disconnect(serverId: string): Promise<McpServerSnapshot | undefined> {
    this.activeConnects.get(serverId)?.abort()
    this.cancelToolsRefresh(serverId)
    return this.serialize(serverId, async () => {
      const record = this.records.get(serverId)
      if (!record) return undefined

      const connection = this.detachConnection(record)
      this.unregisterAll(record)
      record.status = 'disconnected'
      record.error = undefined
      this.emit()

      if (connection) {
        try {
          await connection.close()
        } catch (error) {
          record.error = errorMessage(error)
          this.emit()
        }
      }
      return this.snapshot(record)
    })
  }

  remove(serverId: string): Promise<boolean> {
    this.activeConnects.get(serverId)?.abort()
    this.cancelToolsRefresh(serverId)
    return this.serialize(serverId, async () => {
      const record = this.records.get(serverId)
      if (!record) return false

      const connection = this.detachConnection(record)
      this.unregisterAll(record)
      this.records.delete(serverId)
      this.emit()
      await connection?.close().catch(() => undefined)
      return true
    })
  }

  get(serverId: string): McpServerSnapshot | undefined {
    const record = this.records.get(serverId)
    return record ? this.snapshot(record) : undefined
  }

  list(): readonly McpServerSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record))
  }

  listTools(serverId?: string): readonly McpToolSnapshot[] {
    if (serverId !== undefined) {
      return this.get(serverId)?.tools ?? []
    }
    return this.list().flatMap((server) => server.tools)
  }

  subscribe(listener: McpClientManagerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async connectInternal(
    config: McpServerConfig,
    startingStatus: 'connecting' | 'reconnecting',
    options?: McpOperationOptions,
  ): Promise<McpServerSnapshot> {
    throwIfAborted(options?.signal)
    let record = this.records.get(config.id)
    if (!record) {
      record = {
        config,
        status: 'disconnected',
        registered: new Map(),
      }
      this.records.set(config.id, record)
    }

    const previousConnection = this.detachConnection(record)
    this.unregisterAll(record)
    record.config = config
    record.status = startingStatus
    record.error = undefined
    this.emit()
    await previousConnection?.close().catch(() => undefined)

    let connection: McpConnection | undefined
    try {
      throwIfAborted(options?.signal)
      connection = await this.connector.connect(config, options)
      throwIfAborted(options?.signal)
      record.connection = connection
      record.unsubscribeToolsChanged = connection.onToolsChanged(() => {
        void this.handleToolsChanged(config.id, connection as McpConnection)
      })
      record.unsubscribeClose = connection.onClose((error) => {
        void this.handleUnexpectedClose(config.id, connection as McpConnection, error)
      })

      await this.reconcile(record, connection, options)
      throwIfAborted(options?.signal)
      record.status = 'connected'
      record.error = undefined
      this.emit()
      return this.snapshot(record)
    } catch (error) {
      const caught = toError(error)
      const attached = record.connection === connection
      if (attached) this.detachConnection(record)
      this.unregisterAll(record)
      await connection?.close().catch(() => undefined)
      if (caught.name === 'AbortError') {
        record.status = 'disconnected'
        record.error = undefined
      } else {
        record.status = 'error'
        record.error = caught.message
      }
      this.emit()
      throw caught
    }
  }

  private handleToolsChanged(serverId: string, connection: McpConnection): void {
    const pending = this.toolsRefreshes.get(serverId)
    if (pending?.connection === connection) {
      pending.dirty = true
      return
    }
    if (pending) {
      this.cancelToolsRefresh(serverId)
    }

    const refresh: McpToolsRefresh = {
      connection,
      controller: new AbortController(),
      dirty: false,
    }
    this.toolsRefreshes.set(serverId, refresh)
    const operation = this.serialize(serverId, async () => {
      const record = this.records.get(serverId)
      if (!record || record.connection !== connection || record.status !== 'connected') {
        return
      }

      try {
        await this.reconcile(record, connection, {
          signal: refresh.controller.signal,
        })
        record.error = undefined
        this.emit()
      } catch (error) {
        if (refresh.controller.signal.aborted) return
        await this.failClosed(record, connection, error)
      }
    })
    void operation.finally(() => {
      if (this.toolsRefreshes.get(serverId) !== refresh) return
      this.toolsRefreshes.delete(serverId)
      const record = this.records.get(serverId)
      if (
        refresh.dirty
        && !refresh.controller.signal.aborted
        && record?.connection === connection
        && record.status === 'connected'
      ) {
        this.handleToolsChanged(serverId, connection)
      }
    })
  }

  private handleUnexpectedClose(
    serverId: string,
    connection: McpConnection,
    error?: Error,
  ): Promise<void> {
    this.cancelToolsRefresh(serverId, connection)
    return this.serialize(serverId, async () => {
      const record = this.records.get(serverId)
      if (!record || record.connection !== connection) return
      await this.failClosed(
        record,
        connection,
        error ?? new Error('MCP connection closed unexpectedly'),
      )
    })
  }

  private async failClosed(
    record: McpServerRecord,
    connection: McpConnection,
    error: unknown,
  ): Promise<void> {
    if (record.connection === connection) {
      this.detachConnection(record)
    }
    this.unregisterAll(record)
    record.status = 'error'
    record.error = errorMessage(error)
    this.emit()
    await connection.close().catch(() => undefined)
  }

  private async reconcile(
    record: McpServerRecord,
    connection: McpConnection,
    options?: McpOperationOptions,
  ): Promise<void> {
    const remoteTools = await connection.listTools(options)
    if (!Array.isArray(remoteTools)) {
      throw new Error(`MCP server "${record.config.id}" returned an invalid tool list`)
    }
    if (remoteTools.length > MCP_SERVER_MAX_TOOLS) {
      throw new Error(
        `MCP server "${record.config.id}" exceeded ${MCP_SERVER_MAX_TOOLS} tools`,
      )
    }
    const next = new Map<string, McpRegisteredTool>()

    for (const remoteTool of remoteTools) {
      if (
        !remoteTool ||
        typeof remoteTool.name !== 'string' ||
        !remoteTool.name.trim()
      ) {
        throw new Error(
          `MCP server "${record.config.id}" returned a tool with an empty name`,
        )
      }
      const registered = createMcpToolAdapter({
        serverId: record.config.id,
        remoteTool,
        connection,
        runtime: runtimeFor(record.config),
      })
      const name = registered.tool.name
      if (next.has(name)) {
        throw new Error(
          `MCP server "${record.config.id}" returned colliding tool names for "${name}"`,
        )
      }

      const previous = record.registered.get(name)
      if (
        this.registry.has(name) &&
        (!previous || !this.registry.has(name, previous.tool))
      ) {
        throw new Error(`MCP tool name conflicts with an existing tool: ${name}`)
      }
      next.set(
        name,
        previous && canReuseRegisteredTool(previous, registered)
          ? { tool: previous.tool, snapshot: registered.snapshot }
          : registered,
      )
    }

    // All remote metadata and collisions are validated before mutating registry.
    for (const [name, registered] of next) {
      const previous = record.registered.get(name)
      if (!previous || previous.tool !== registered.tool) {
        this.registry.register(registered.tool)
      }
    }
    for (const [name, previous] of record.registered) {
      if (!next.has(name)) {
        this.registry.unregister(name, previous.tool)
      }
    }
    record.registered = next
  }

  private detachConnection(record: McpServerRecord): McpConnection | undefined {
    record.unsubscribeToolsChanged?.()
    record.unsubscribeClose?.()
    record.unsubscribeToolsChanged = undefined
    record.unsubscribeClose = undefined
    const connection = record.connection
    if (connection) {
      this.cancelToolsRefresh(record.config.id, connection)
    }
    record.connection = undefined
    return connection
  }

  private unregisterAll(record: McpServerRecord): void {
    for (const [name, registered] of record.registered) {
      this.registry.unregister(name, registered.tool)
    }
    record.registered.clear()
  }

  private snapshot(record: McpServerRecord): McpServerSnapshot {
    return {
      id: record.config.id,
      config: cloneConfig(record.config),
      status: record.status,
      tools: [...record.registered.values()].map(({ snapshot }) =>
        cloneToolSnapshot(snapshot),
      ),
      ...(record.error ? { error: record.error } : {}),
    }
  }

  private emit(): void {
    const servers = this.list()
    for (const listener of [...this.listeners]) {
      try {
        listener(servers)
      } catch {
        // Subscribers are observers; one faulty observer must not break lifecycle cleanup.
      }
    }
  }

  private replaceConnectController(serverId: string): AbortController {
    this.activeConnects.get(serverId)?.abort()
    this.cancelToolsRefresh(serverId)
    const controller = new AbortController()
    this.activeConnects.set(serverId, controller)
    return controller
  }

  private releaseConnectController(serverId: string, controller: AbortController): void {
    if (this.activeConnects.get(serverId) === controller) {
      this.activeConnects.delete(serverId)
    }
  }

  private cancelToolsRefresh(
    serverId: string,
    expectedConnection?: McpConnection,
  ): void {
    const refresh = this.toolsRefreshes.get(serverId)
    if (
      !refresh
      || (expectedConnection !== undefined && refresh.connection !== expectedConnection)
    ) {
      return
    }
    this.toolsRefreshes.delete(serverId)
    refresh.controller.abort()
  }

  private serialize<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(serverId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.operationTails.set(serverId, tail)
    void tail.then(() => {
      if (this.operationTails.get(serverId) === tail) {
        this.operationTails.delete(serverId)
      }
    })
    return result
  }
}

export function createMcpClientManager(
  options: McpClientManagerOptions,
): McpClientManager {
  return new McpClientManager(options)
}
