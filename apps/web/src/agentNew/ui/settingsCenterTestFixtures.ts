import type { McpServerConfig, McpServerSnapshot } from '@einfach-agent/tools-mcp'
import type { McpSettingsManager } from '../../mcp/service'

function connectedSnapshot(config: McpServerConfig): McpServerSnapshot {
  return {
    id: config.id,
    config,
    status: 'connected',
    tools: [{
      name: `mcp__${config.id}__search`,
      remoteName: 'search',
      description: 'Search',
      inputSchema: { type: 'object' },
    }],
  }
}

/** Provides an in-memory MCP manager for SettingsCenter interaction tests. */
export class UiMcpManager implements McpSettingsManager {
  private readonly snapshots = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()

  async register(config: McpServerConfig): Promise<McpServerSnapshot> {
    const existing = this.snapshots.get(config.id)
    if (existing) return existing
    const next: McpServerSnapshot = { id: config.id, config, status: 'disconnected', tools: [] }
    this.snapshots.set(config.id, next)
    this.emit()
    return next
  }

  async connect(config: McpServerConfig): Promise<McpServerSnapshot> {
    const next = connectedSnapshot(config)
    this.snapshots.set(config.id, next)
    this.emit()
    return next
  }

  async reconnect(id: string): Promise<McpServerSnapshot> {
    const current = this.snapshots.get(id)
    if (!current) throw new Error('unknown server')
    return this.connect(current.config)
  }

  async disconnect(id: string): Promise<McpServerSnapshot | undefined> {
    const current = this.snapshots.get(id)
    if (!current) return undefined
    const next = { ...current, status: 'disconnected' as const, tools: [] }
    this.snapshots.set(id, next)
    this.emit()
    return next
  }

  async remove(id: string): Promise<boolean> {
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
    for (const listener of this.listeners) listener(this.list())
  }
}
