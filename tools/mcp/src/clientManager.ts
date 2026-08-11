import { classifyMcpFailure } from './failureClassification'
import {
  combineAbortSignals,
  errorMessage,
  throwIfAborted,
  toError,
} from './internal'
import {
  McpReconnectScheduler,
  mcpReconnectExhaustedMessage,
} from './reconnectSchedule'
import { cloneConfig, validateConfig } from './serverConfig'
import { createStreamableHttpMcpConnector } from './streamableHttp'
import { cloneToolSnapshot, reconcileMcpTools } from './toolReconciler'
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

/**
 * Owns MCP connections and reconciles their remote tools into one ToolRegistry.
 *
 * Operations are serialized per server. Transport callbacks are generation-safe
 * through connection identity checks, so an old close/list_changed event cannot
 * mutate a newer connection. A temporary failure ('reconnecting') arms a capped
 * exponential backoff (reconnectSchedule.ts); a permanent one ('error') never retries.
 */
export class McpClientManager {
  private readonly registry: McpClientManagerOptions['registry']
  private readonly connector: McpConnector
  private readonly records = new Map<string, McpServerRecord>()
  private readonly listeners = new Set<McpClientManagerListener>()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly activeConnects = new Map<string, AbortController>()
  private readonly toolsRefreshes = new Map<string, McpToolsRefresh>()
  /**
   * 挂起的退避重连。定时器不属于任何一次 serialize 操作，所以每条会改变连接世代的路径
   * 都必须显式 cancel 它：connect / reconnect / disconnect / remove / 连接成功。
   */
  private readonly reconnects = new McpReconnectScheduler()

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
    // 手动操作打断退避：用户不该被迫等完剩下的 30 秒。
    this.reconnects.cancel(ownedConfig.id)
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
    this.reconnects.cancel(serverId)
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
    this.reconnects.cancel(serverId)
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
    this.reconnects.cancel(serverId)
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
      // 连上了就把重试预算还回去：下一次断线是一条新的重连链。
      this.reconnects.cancel(config.id)
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
        const classification = classifyMcpFailure(caught)
        record.status = classification.status
        record.error = classification.message
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
    const classification = classifyMcpFailure(error)
    record.status = classification.status
    record.error = classification.message
    // 只有暂时失败才重试；永久失败一次都不试。
    if (classification.status === 'reconnecting') {
      this.armReconnect(record, error)
    }
    this.emit()
    await connection.close().catch(() => undefined)
  }

  /** 安排下一次退避重试；预算耗尽就地落成永久失败。不 emit，由调用方统一 emit。 */
  private armReconnect(record: McpServerRecord, error: unknown): void {
    const serverId = record.config.id
    const plan = this.reconnects.schedule(serverId, () => {
      this.startScheduledReconnect(serverId)
    })
    if (plan.scheduled) return
    record.status = 'error'
    record.error = mcpReconnectExhaustedMessage(plan.attempts, errorMessage(error))
  }

  /**
   * 退避定时器落地。走与手动重连同一条路：先占住 activeConnects 的控制器（这样之后任何
   * connect / reconnect / disconnect 都能立刻打断本次尝试），再进 serialize 队列。
   *
   * 世代检查必须在队列里做：定时器触发到操作真正执行之间隔着整条队列，期间连接身份
   * 可能已经换过一轮。判据沿用既有那套 —— 记录还在、名下没有新连接（connection 身份）、
   * 状态仍是 'reconnecting'、本次控制器没被抢走。这四条目前是纵深防御：换代的公开路径
   * 都已在入口取消退避，connectInternal 也会 throwIfAborted，现有 API 走不到它们为 false，
   * 因此没有测试覆盖。将来出现「不经 replaceConnectController 就换连接」的路径
   * （如 D3 keepalive）时这里是最后一道闸，别当死代码删。
   */
  private startScheduledReconnect(serverId: string): void {
    const controller = this.replaceConnectController(serverId)
    void this.serialize(serverId, async () => {
      try {
        const record = this.records.get(serverId)
        if (
          !record
          || record.connection !== undefined
          || record.status !== 'reconnecting'
          || controller.signal.aborted
        ) {
          return
        }
        await this.connectInternal(cloneConfig(record.config), 'reconnecting', {
          signal: controller.signal,
        })
      } catch (error) {
        this.continueReconnect(serverId, toError(error))
      } finally {
        this.releaseConnectController(serverId, controller)
      }
    })
  }

  /** 一次重试失败后接上下一次；被打断或已判成永久失败则收手。 */
  private continueReconnect(serverId: string, error: Error): void {
    if (error.name === 'AbortError') return
    const record = this.records.get(serverId)
    // connectInternal 已按分类写好状态：不是 'reconnecting' 就说明这次失败是永久的，
    // 或者记录已经被 disconnect / remove 带走了。
    if (!record || record.status !== 'reconnecting') return
    this.armReconnect(record, error)
    this.emit()
  }

  private async reconcile(
    record: McpServerRecord,
    connection: McpConnection,
    options?: McpOperationOptions,
  ): Promise<void> {
    record.registered = await reconcileMcpTools({
      registry: this.registry,
      config: record.config,
      connection,
      registered: record.registered,
      ...(options ? { options } : {}),
    })
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

  /**
   * 注意：这里**不能**顺手 cancel 退避 —— 自动重试自己也走这条路，在这里重置次数
   * 会让上限永远回到 0，等于无限重试。取消退避是手动操作与 remove/disconnect 的事。
   */
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
