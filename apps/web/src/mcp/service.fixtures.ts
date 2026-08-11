import { vi } from 'vitest'
import type {
  McpServerConfig,
  McpServerSnapshot,
  McpServerStatus,
} from '@web-agent/tools-mcp'
import type { McpConfigStorage } from './persistence'
import type { McpSettingsManager } from './service'
import type { PersistedMcpServerConfig } from './types'

/** MCP 设置服务的测试替身：一个内存 manager 和一个内存配置存储。只被测试 import。 */

export function snapshot(
  config: McpServerConfig,
  status: McpServerStatus = 'connected',
): McpServerSnapshot {
  return {
    id: config.id,
    config,
    status,
    tools: status === 'connected'
      ? [{
          name: `mcp__${config.id}__search`,
          remoteName: 'search',
          description: 'Search',
          inputSchema: { type: 'object' },
        }]
      : [],
  }
}

export class FakeMcpManager implements McpSettingsManager {
  readonly registerCalls: McpServerConfig[] = []
  readonly connectCalls: McpServerConfig[] = []
  readonly reconnectCalls: string[] = []
  readonly disconnectCalls: string[] = []
  readonly removeCalls: string[] = []

  private readonly snapshots = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()

  /** 复刻真实 manager：只建一条 'disconnected' 记录，已登记过的原样返回，绝不连接。 */
  async register(config: McpServerConfig): Promise<McpServerSnapshot> {
    this.registerCalls.push(config)
    const existing = this.snapshots.get(config.id)
    if (existing) return existing
    const next: McpServerSnapshot = {
      id: config.id,
      config,
      status: 'disconnected',
      tools: [],
    }
    this.snapshots.set(config.id, next)
    this.emit()
    return next
  }

  async connect(config: McpServerConfig): Promise<McpServerSnapshot> {
    this.connectCalls.push(config)
    const next = snapshot(config)
    this.snapshots.set(config.id, next)
    this.emit()
    return next
  }

  async reconnect(id: string): Promise<McpServerSnapshot> {
    this.reconnectCalls.push(id)
    const current = this.snapshots.get(id)
    if (!current) throw new Error(`unknown server: ${id}`)
    const next = snapshot(current.config)
    this.snapshots.set(id, next)
    this.emit()
    return next
  }

  async disconnect(id: string): Promise<McpServerSnapshot | undefined> {
    this.disconnectCalls.push(id)
    const current = this.snapshots.get(id)
    if (!current) return undefined
    const next = snapshot(current.config, 'disconnected')
    this.snapshots.set(id, next)
    this.emit()
    return next
  }

  async remove(id: string): Promise<boolean> {
    this.removeCalls.push(id)
    const removed = this.snapshots.delete(id)
    this.emit()
    return removed
  }

  get(id: string): McpServerSnapshot | undefined {
    return this.snapshots.get(id)
  }

  list(): readonly McpServerSnapshot[] {
    return [...this.snapshots.values()]
  }

  subscribe(listener: (servers: readonly McpServerSnapshot[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const servers = this.list()
    for (const listener of this.listeners) listener(servers)
  }
}

export function createStorage(initial: readonly PersistedMcpServerConfig[] = []): {
  storage: McpConfigStorage
  load: ReturnType<typeof vi.fn<McpConfigStorage['load']>>
  save: ReturnType<typeof vi.fn<McpConfigStorage['save']>>
} {
  let configs = [...initial]
  const load = vi.fn<McpConfigStorage['load']>(async () => configs)
  const save = vi.fn<McpConfigStorage['save']>(async (next) => {
    configs = [...next]
  })
  return {
    storage: { persistence: 'persistent', load, save },
    load,
    save,
  }
}
