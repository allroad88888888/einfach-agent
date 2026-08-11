import { cloneConfig } from './serverConfig'
import { cloneToolSnapshot } from './toolReconciler'
import type {
  McpClientManagerListener,
  McpConnection,
  McpRegisteredTool,
  McpServerConfig,
  McpServerSnapshot,
  McpServerStatus,
} from './types'

/**
 * MCP 服务的【登记表】：谁被登记过、一条记录持有什么、它对外投影成什么快照，
 * 以及这些快照怎么广播给订阅者。
 *
 * 从 clientManager.ts 拆出来是因为「登记」和「连接」本就是两件事：一个服务可以只被登记
 * 而从未连接过（按需模式下宿主在冷启动时登记配置里的全部服务，连接由模型按需触发）。
 * 本文件因此刻意不认识连接器、退避调度与串行队列 —— 它不决定状态什么时候变，
 * 只保管记录、投影快照、通知订阅者。连接状态机完整地留在 clientManager.ts。
 */

/**
 * 一个已登记服务的全部内部状态。
 *
 * `connection === undefined` 有两种来历，而且【对外不可区分】：只登记从未连过，
 * 或者连过之后断开了。两者都是 status 'disconnected' + 空工具表，含义都是
 * 「现在没有连接，要用就得连一次」—— 所以没有第三种状态，也不需要有。
 */
export interface McpServerRecord {
  config: McpServerConfig
  status: McpServerStatus
  error?: string
  connection?: McpConnection
  unsubscribeToolsChanged?: () => void
  unsubscribeClose?: () => void
  registered: Map<string, McpRegisteredTool>
}

/** 新建一条只登记、未连接的记录。 */
function createRecord(config: McpServerConfig): McpServerRecord {
  return { config, status: 'disconnected', registered: new Map() }
}

export class McpServerRecords {
  private readonly records = new Map<string, McpServerRecord>()
  private readonly listeners = new Set<McpClientManagerListener>()

  /** 取一条记录；取不到就是「这个服务没被登记过」。 */
  get(serverId: string): McpServerRecord | undefined {
    return this.records.get(serverId)
  }

  /**
   * 取出该 id 的记录，没有就以 'disconnected' 新建一条。
   *
   * 【绝不覆盖已有记录】：它可能正连着、正在退避重试、或刚落成永久失败，
   * 重置回 'disconnected' 会同时抹掉连接身份和失败原因。`created` 让调用方知道
   * 这次到底新增了没有 —— 只有新增才值得广播。
   */
  ensure(config: McpServerConfig): { record: McpServerRecord; created: boolean } {
    const existing = this.records.get(config.id)
    if (existing) return { record: existing, created: false }
    const record = createRecord(config)
    this.records.set(config.id, record)
    return { record, created: true }
  }

  delete(serverId: string): boolean {
    return this.records.delete(serverId)
  }

  /** 对外可见的投影：配置与工具都是深拷贝，订阅者改不到管理器的内部状态。 */
  snapshot(record: McpServerRecord): McpServerSnapshot {
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

  list(): readonly McpServerSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record))
  }

  subscribe(listener: McpClientManagerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    const servers = this.list()
    for (const listener of [...this.listeners]) {
      try {
        listener(servers)
      } catch {
        // Subscribers are observers; one faulty observer must not break lifecycle cleanup.
      }
    }
  }
}
