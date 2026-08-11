import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, McpServerSnapshot } from '@web-agent/tools-mcp'
import { createMemoryMcpConfigStorage } from './persistence'
import { createMcpInstallProber } from './probeOnInstall'
import { createMcpSettingsService, type McpSettingsManager } from './service'
import {
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpImportStatusAtom,
  mcpServerConfigsAtom,
  mcpServersAtom,
} from './state'
import {
  createMemoryToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import type { McpAddServerDraft } from './types'

interface ServerPlan { tools?: readonly string[]; failWith?: string; gate?: Promise<void> }

/** 复刻真实 McpClientManager 的关键行为：失败前先 emit 一份失败快照再 reject。 */
class FakeProbeManager implements McpSettingsManager {
  readonly connectCalls: string[] = []
  readonly disconnectCalls: string[] = []
  private readonly plans = new Map<string, ServerPlan>()
  private readonly snapshots = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()

  plan(id: string, plan: ServerPlan): void {
    this.plans.set(id, plan)
  }

  async register(config: McpServerConfig): Promise<McpServerSnapshot> {
    const existing = this.snapshots.get(config.id)
    return existing ?? this.publish({ id: config.id, config, status: 'disconnected', tools: [] })
  }

  async connect(config: McpServerConfig): Promise<McpServerSnapshot> {
    this.connectCalls.push(config.id)
    const plan = this.plans.get(config.id) ?? {}
    await plan.gate
    if (plan.failWith) {
      this.publish({ id: config.id, config, status: 'error', tools: [], error: plan.failWith })
      throw new Error(plan.failWith)
    }
    return this.publish({
      id: config.id,
      config,
      status: 'connected',
      tools: (plan.tools ?? ['search']).map((name) => ({
        name: `mcp__${config.id}__${name}`,
        remoteName: name,
        description: `${name} 工具`,
        inputSchema: { type: 'object' },
      })),
    })
  }

  async reconnect(id: string): Promise<McpServerSnapshot> {
    throw new Error(`安装探测不会走重连：${id}`)
  }

  async disconnect(id: string): Promise<McpServerSnapshot | undefined> {
    this.disconnectCalls.push(id)
    const current = this.snapshots.get(id)
    if (!current) return undefined
    return this.publish({ ...current, status: 'disconnected', tools: [], error: undefined })
  }

  async remove(id: string): Promise<boolean> {
    return this.snapshots.delete(id)
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

  private publish(snapshot: McpServerSnapshot): McpServerSnapshot {
    this.snapshots.set(snapshot.id, snapshot)
    this.emit()
    return snapshot
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.list())
  }
}

/** save 慢到能横跨好几个 tick，模拟 Tauri IPC 往返打开的让出点。 */
function createSlowCacheStorage(): McpToolNameCacheStorage {
  const inner = createMemoryToolNameCacheStorage()
  return {
    persistence: inner.persistence,
    load: inner.load,
    async save(next) {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
      await inner.save(next)
    },
  }
}

const HTTP_DRAFT: McpAddServerDraft = {
  name: '团队搜索',
  transport: 'streamable-http',
  url: 'https://search.example.com/mcp',
  command: '',
  argsText: '',
  cwd: '',
  autoConnect: false,
}

function setup(options: { ids?: readonly string[]; stdio?: boolean } = {}) {
  const store = createStore()
  const manager = new FakeProbeManager()
  const storage = createMemoryMcpConfigStorage()
  const cacheStorage = createSlowCacheStorage()
  const ids = [...(options.ids ?? ['team-search'])]
  let nextId = 0
  const service = createMcpSettingsService({
    store,
    manager,
    storage,
    toolNameCacheStorage: cacheStorage,
    capabilities: { stdio: options.stdio === true },
    createId: () => ids[nextId++] ?? `extra-${nextId}`,
  })
  return { store, manager, storage, cacheStorage, service }
}

describe('MCP 安装即探测', () => {
  it('探测新增的 HTTP 服务、写入工具名缓存，然后断开连接', async () => {
    const { store, manager, cacheStorage, service } = setup()
    manager.plan('team-search', { tools: ['search', 'fetch'] })
    store.setter(mcpDraftAtom, { ...HTTP_DRAFT })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(manager.connectCalls).toEqual(['team-search'])
    // 未开自动连接的服务不该在安装后继续占着连接，工具也不该留在 registry 里，
    // 否则就绕过了 connect_mcp_server 的惰性加载分层。
    expect(manager.disconnectCalls).toEqual(['team-search'])
    expect(await cacheStorage.load()).toEqual({
      'team-search': {
        tools: [
          { name: 'mcp__team-search__search', description: 'search 工具' },
          { name: 'mcp__team-search__fetch', description: 'fetch 工具' },
        ],
        toolCount: 2,
        cachedAt: expect.any(Number),
        probeStatus: 'success',
      },
    })
    expect(store.getter(mcpImportStatusAtom)).toContain('检测到 2 个可用工具')
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'disconnected', autoConnect: false }),
    )
  })

  it('自动连接的服务复用那一次连接，不为探测再连一次也不断开', async () => {
    const { store, manager, cacheStorage, service } = setup()
    store.setter(mcpDraftAtom, { ...HTTP_DRAFT, autoConnect: true })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(manager.connectCalls).toEqual(['team-search'])
    expect(manager.disconnectCalls).toEqual([])
    expect((await cacheStorage.load())['team-search']).toEqual(
      expect.objectContaining({ toolCount: 1, probeStatus: 'success' }),
    )
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'connected', toolCount: 1 }),
    )
  })

  it('探测失败不阻断保存：配置照存、缓存记 failed、界面给出提示', async () => {
    const { store, manager, storage, cacheStorage, service } = setup()
    manager.plan('team-search', { failWith: '连接被拒绝：404' })
    store.setter(mcpDraftAtom, { ...HTTP_DRAFT })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(store.getter(mcpServerConfigsAtom)).toEqual([
      expect.objectContaining({ id: 'team-search', url: 'https://search.example.com/mcp' }),
    ])
    expect(await storage.load()).toEqual([expect.objectContaining({ id: 'team-search' })])
    expect(await cacheStorage.load()).toEqual({
      'team-search': {
        tools: [],
        toolCount: 0,
        cachedAt: expect.any(Number),
        probeStatus: 'failed',
      },
    })
    expect(store.getter(mcpFormErrorAtom)).toBeUndefined()
    expect(store.getter(mcpImportStatusAtom)).toContain('连接检测失败：连接被拒绝：404')
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'error', error: '连接被拒绝：404' }),
    )
  })

  it('stdio 一律跳过探测，绝不起进程（该限制由 H2 解除）', async () => {
    const { store, manager, cacheStorage, service } = setup({ stdio: true })
    store.setter(mcpDraftAtom, {
      ...HTTP_DRAFT,
      name: 'Playwright MCP',
      transport: 'stdio',
      url: '',
      command: 'npx',
      argsText: '-y\n@playwright/mcp@latest',
    })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(manager.connectCalls).toEqual([])
    expect(await cacheStorage.load()).toEqual({})
    expect(store.getter(mcpImportStatusAtom)).toContain('stdio')
  })

  it('批量导入立刻返回，后台逐个探测并报告进度', async () => {
    const ids = ['import-a', 'import-b', 'import-c']
    const { store, manager, cacheStorage, service } = setup({ ids })
    let releaseFirst!: () => void
    manager.plan('import-a', {
      gate: new Promise<void>((resolve) => {
        releaseFirst = resolve
      }),
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        a: { url: 'https://a.example.com/mcp' },
        b: { url: 'https://b.example.com/mcp' },
        c: { url: 'https://c.example.com/mcp' },
      },
    }))).resolves.toBe(true)

    // 导入已经落盘并返回，第一次探测还卡在网关上：界面没有被 N 次连接拖住，
    // 而且后面两个还没开始连——逐个探测，不并发轰炸。
    expect(store.getter(mcpServerConfigsAtom)).toHaveLength(3)
    expect(manager.connectCalls).toEqual(['import-a'])
    expect(store.getter(mcpImportStatusAtom)).toContain('（1/3）')

    releaseFirst()
    await vi.waitFor(() => {
      expect(store.getter(mcpImportStatusAtom)).toBe('已导入 3 个 MCP 服务：3 个检测可用。')
    })
    expect(manager.connectCalls).toEqual(ids)
    expect(manager.disconnectCalls).toEqual(ids)
    expect(Object.keys(await cacheStorage.load()).sort()).toEqual(ids)
  })

  it('批量导入里的 stdio 只计入待确认，不参与探测', async () => {
    const { store, manager, cacheStorage, service } = setup({
      ids: ['import-http', 'import-stdio'],
      stdio: true,
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        remote: { url: 'https://remote.example.com/mcp' },
        local: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
    }))).resolves.toBe(true)

    await vi.waitFor(() => {
      expect(store.getter(mcpImportStatusAtom)).toBe(
        '已导入 2 个 MCP 服务：1 个检测可用，1 个 stdio 服务需手动连接后才检测。',
      )
    })
    expect(manager.connectCalls).toEqual(['import-http'])
    expect(Object.keys(await cacheStorage.load())).toEqual(['import-http'])
  })

  it('并发探测多个服务时不丢缓存条目', async () => {
    // 缓存是整份对象，一次写入是读-改-写：读到旧快照再写回就会盖掉别人刚写的那条。
    // 按 serverId 分桶的串行队列管不着这件事——不同服务之间本来就允许并行。
    const cacheStorage = createSlowCacheStorage()
    const prober = createMcpInstallProber({
      manager: new FakeProbeManager(),
      cacheStorage,
      runExclusive: (_id, operation) => operation(),
      report: () => {},
      shouldProbe: () => true,
    })
    const probe = (id: string): Promise<unknown> => prober.probeInstalled({
      id, name: id, transport: 'streamable-http', autoConnect: false,
      url: `https://${id}.example.com/mcp`,
    })

    await probe('a')
    await Promise.all([probe('b'), probe('c')])

    expect(Object.keys(await cacheStorage.load()).sort()).toEqual(['a', 'b', 'c'])
  })
})
