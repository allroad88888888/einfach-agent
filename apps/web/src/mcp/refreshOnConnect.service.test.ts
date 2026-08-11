import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, McpServerSnapshot } from '@web-agent/tools-mcp'
import { createMemoryMcpConfigStorage } from './persistence'
import { createMcpSettingsService, type McpSettingsManager } from './service'
import { mcpServersAtom } from './state'
import type { McpToolNameCache } from './toolNameCache'
import {
  createMemoryToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import type { PersistedMcpServerConfig } from './types'

/** 判据接到 service 上：订阅 manager 快照之后，缓存跟着真实连接走。 */

/** 复刻真实 manager 的广播时机：连上/断开/对账后各 emit 一次全量快照。 */
class FakeRefreshManager implements McpSettingsManager {
  private readonly records = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()
  private readonly toolNames = new Map<string, readonly string[]>()

  setTools(id: string, names: readonly string[]): void {
    this.toolNames.set(id, names)
  }

  async register(config: McpServerConfig): Promise<McpServerSnapshot> {
    const existing = this.records.get(config.id)
    if (existing) return existing
    return this.publish({ id: config.id, config, status: 'disconnected', tools: [] })
  }

  async connect(config: McpServerConfig): Promise<McpServerSnapshot> {
    return this.publish({
      id: config.id,
      config,
      status: 'connected',
      tools: this.toolsOf(config.id),
    })
  }

  async reconnect(id: string): Promise<McpServerSnapshot> {
    const current = this.records.get(id)
    if (!current) throw new Error(`unknown server: ${id}`)
    return this.publish({ ...current, status: 'connected', tools: this.toolsOf(id) })
  }

  async disconnect(id: string): Promise<McpServerSnapshot | undefined> {
    const current = this.records.get(id)
    if (!current) return undefined
    return this.publish({ ...current, status: 'disconnected', tools: [] })
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.records.delete(id)
    this.emit()
    return removed
  }

  get(id: string): McpServerSnapshot | undefined {
    return this.records.get(id)
  }

  list(): readonly McpServerSnapshot[] {
    return [...this.records.values()]
  }

  subscribe(listener: (servers: readonly McpServerSnapshot[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** tools/list_changed：manager 重新对账后再 emit 一份仍是 connected 的快照。 */
  publishToolsChanged(id: string, names: readonly string[]): void {
    const current = this.records.get(id)
    if (!current) throw new Error(`unknown server: ${id}`)
    this.setTools(id, names)
    this.publish({ ...current, status: 'connected', tools: this.toolsOf(id) })
  }

  /** 别的服务动一下就会把全量快照重放一遍。 */
  republish(): void {
    this.emit()
  }

  private toolsOf(id: string): McpServerSnapshot['tools'] {
    return (this.toolNames.get(id) ?? ['search']).map((remoteName) => ({
      name: `mcp__${id}__${remoteName}`,
      remoteName,
      description: `${remoteName} 工具`,
      inputSchema: { type: 'object' },
    }))
  }

  private publish(next: McpServerSnapshot): McpServerSnapshot {
    this.records.set(next.id, next)
    this.emit()
    return next
  }

  private emit(): void {
    const servers = this.list()
    for (const listener of [...this.listeners]) listener(servers)
  }
}

function createCountingCacheStorage(initial: McpToolNameCache = {}): {
  storage: McpToolNameCacheStorage
  saved: McpToolNameCache[]
} {
  const inner = createMemoryToolNameCacheStorage(initial)
  const saved: McpToolNameCache[] = []
  return {
    saved,
    storage: {
      persistence: inner.persistence,
      load: inner.load,
      async save(next) {
        saved.push(next)
        for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
        await inner.save(next)
      },
    },
  }
}

const DOCS: PersistedMcpServerConfig = {
  id: 'docs',
  name: '文档',
  transport: 'streamable-http',
  url: 'https://docs.example.com/mcp',
  autoConnect: true,
}

const CACHED_DOCS: McpToolNameCache = {
  docs: {
    tools: [{ name: 'mcp__docs__search', description: '搜索文档' }],
    toolCount: 1,
    cachedAt: 1_700_000_000_000,
    probeStatus: 'success',
  },
}

function setup(
  configs: readonly PersistedMcpServerConfig[],
  initialCache: McpToolNameCache = {},
) {
  const store = createStore()
  const manager = new FakeRefreshManager()
  const { storage: cacheStorage, saved } = createCountingCacheStorage(initialCache)
  const service = createMcpSettingsService({
    store,
    manager,
    storage: createMemoryMcpConfigStorage(configs),
    toolNameCacheStorage: cacheStorage,
  })
  return { store, manager, cacheStorage, saved, service }
}

describe('MCP 连接成功刷新工具名缓存 · 接进 service', () => {
  it('冷启动自动连上的服务，缓存里是它这一刻的真实工具清单', async () => {
    const { manager, cacheStorage, service } = setup([DOCS])
    manager.setTools('docs', ['search', 'draft'])

    await service.hydrate()

    await vi.waitFor(async () => {
      expect((await cacheStorage.load()).docs).toEqual({
        tools: [
          { name: 'mcp__docs__search', description: 'search 工具' },
          { name: 'mcp__docs__draft', description: 'draft 工具' },
        ],
        toolCount: 2,
        cachedAt: expect.any(Number),
        probeStatus: 'success',
      })
    })
  })

  it('断开之后缓存原样保留，界面回到未连接', async () => {
    const { store, cacheStorage, saved, service } = setup([DOCS])
    await service.hydrate()
    await vi.waitFor(async () => expect((await cacheStorage.load()).docs).toBeDefined())
    const cached = await cacheStorage.load()

    await service.disconnect('docs')

    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'disconnected', toolCount: 0 }),
    )
    expect(await cacheStorage.load()).toEqual(cached)
    expect(saved).toHaveLength(1)
  })

  it('冷启动只登记不连接的服务不会把已有缓存冲成空', async () => {
    // F6 之后 hydrate 会登记【全部】已配置服务，manager 立刻 emit 一批
    // status 'disconnected' + 空工具表的快照——它不代表这些服务没有工具。
    const { manager, cacheStorage, saved, service } = setup(
      [{ ...DOCS, autoConnect: false }],
      CACHED_DOCS,
    )

    await service.hydrate()
    manager.republish()
    await Promise.resolve()

    expect(await cacheStorage.load()).toEqual(CACHED_DOCS)
    expect(saved).toEqual([])
  })

  it('连着的时候收到 tools/list_changed，缓存跟着换成新清单', async () => {
    const { manager, cacheStorage, saved, service } = setup([DOCS])
    await service.hydrate()
    await vi.waitFor(async () => expect((await cacheStorage.load()).docs).toBeDefined())

    manager.publishToolsChanged('docs', ['search', 'draft', 'publish'])

    await vi.waitFor(async () => {
      expect((await cacheStorage.load()).docs).toEqual(
        expect.objectContaining({ toolCount: 3 }),
      )
    })
    // 连接一次 + 对账一次，中间那些重放的快照都没有落盘。
    expect(saved).toHaveLength(2)
  })

  it('dispose 之后的快照不再写缓存', async () => {
    const { manager, cacheStorage, saved, service } = setup([{ ...DOCS, autoConnect: false }])
    await service.hydrate()
    service.dispose()

    await manager.connect({
      id: 'docs',
      name: '文档',
      transport: 'streamable-http',
      url: 'https://docs.example.com/mcp',
    })

    expect(saved).toEqual([])
    expect(await cacheStorage.load()).toEqual({})
  })
})
