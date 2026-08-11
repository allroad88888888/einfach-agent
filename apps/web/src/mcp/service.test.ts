import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  McpServerConfig,
  McpServerSnapshot,
  McpServerStatus,
} from '@web-agent/tools-mcp'
import { createMcpSettingsService, type McpSettingsManager } from './service'
import {
  MCP_SETTINGS_MAX_SERVERS,
  type McpConfigStorage,
} from './persistence'
import {
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpHydrationAtom,
  mcpServerConfigsAtom,
  mcpServersAtom,
} from './state'
import type { PersistedMcpServerConfig } from './types'

const PLAYWRIGHT_MCP_JSON = `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}`

function snapshot(
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

class FakeMcpManager implements McpSettingsManager {
  readonly connectCalls: McpServerConfig[] = []
  readonly reconnectCalls: string[] = []
  readonly disconnectCalls: string[] = []
  readonly removeCalls: string[] = []

  private readonly snapshots = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()

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

function createStorage(initial: readonly PersistedMcpServerConfig[] = []): {
  storage: McpConfigStorage
  load: ReturnType<typeof vi.fn<McpConfigStorage['load']>>
  save: ReturnType<typeof vi.fn<McpConfigStorage['save']>>
} {
  let configs = [...initial]
  const load = vi.fn<McpConfigStorage['load']>(() => configs)
  const save = vi.fn<McpConfigStorage['save']>((next) => {
    configs = [...next]
  })
  return {
    storage: { persistence: 'persistent', load, save },
    load,
    save,
  }
}

describe('MCP settings service', () => {
  let manager: FakeMcpManager

  beforeEach(() => {
    manager = new FakeMcpManager()
  })

  it('hydrates once, auto-connects HTTP, and never auto-starts legacy stdio configs', async () => {
    const store = createStore()
    const automatic: PersistedMcpServerConfig = {
      id: 'knowledge',
      name: '知识库',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/',
      autoConnect: true,
    }
    const manual: PersistedMcpServerConfig = {
      id: 'local-files',
      name: '本地文件',
      transport: 'stdio',
      command: 'mcp-files',
      args: ['--root', '/workspace'],
      // Simulates a legacy value written before stdio was made manual-only.
      autoConnect: true,
    }
    const { storage, load, save } = createStorage([automatic, manual])
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
    })

    await service.hydrate()
    await service.hydrate()

    expect(load).toHaveBeenCalledTimes(1)
    expect(manager.connectCalls).toEqual([{
      id: 'knowledge',
      name: '知识库',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/',
    }])
    expect(save).toHaveBeenCalledWith([
      automatic,
      { ...manual, autoConnect: false },
    ])
    expect(store.getter(mcpServerConfigsAtom)).toEqual([
      automatic,
      { ...manual, autoConnect: false },
    ])
    expect(store.getter(mcpHydrationAtom)).toEqual({ status: 'ready' })
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({
        id: 'knowledge',
        status: 'connected',
        toolCount: 1,
      }),
      expect.objectContaining({
        id: 'local-files',
        status: 'disconnected',
        toolCount: 0,
      }),
    ])
  })

  it('coalesces concurrent hydration, retries after failure, and stays cached after success', async () => {
    const store = createStore()
    const { storage, load } = createStorage()
    load.mockImplementationOnce(() => {
      throw new Error('temporary storage failure')
    })
    const service = createMcpSettingsService({ store, manager, storage })

    const first = service.hydrate()
    const concurrent = service.hydrate()

    expect(concurrent).toBe(first)
    await first
    expect(load).toHaveBeenCalledTimes(1)
    expect(store.getter(mcpHydrationAtom)).toEqual({
      status: 'error',
      error: '无法读取 MCP 设置：temporary storage failure',
    })

    const retry = service.hydrate()
    expect(retry).not.toBe(first)
    await retry
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.getter(mcpHydrationAtom)).toEqual({ status: 'ready' })

    const cached = service.hydrate()
    expect(cached).toBe(retry)
    await cached
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('saves a valid draft, connects it, and never passes persistence-only fields to the manager', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      createId: () => 'team-search',
    })
    store.setter(mcpAddFormOpenAtom, true)
    store.setter(mcpDraftAtom, {
      name: '团队搜索',
      transport: 'streamable-http',
      url: 'https://search.example.com/mcp',
      command: '',
      argsText: '',
      cwd: '',
      autoConnect: true,
    })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(save).toHaveBeenCalledWith([{
      id: 'team-search',
      name: '团队搜索',
      transport: 'streamable-http',
      url: 'https://search.example.com/mcp',
      autoConnect: true,
    }])
    expect(manager.connectCalls).toEqual([{
      id: 'team-search',
      name: '团队搜索',
      transport: 'streamable-http',
      url: 'https://search.example.com/mcp',
    }])
    expect(store.getter(mcpAddFormOpenAtom)).toBe(false)
    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      status: 'connected',
      toolCount: 1,
    }))
  })

  it("keeps the manager's own status classification on a connect failure instead of forcing 'error'", async () => {
    const store = createStore()
    const { storage } = createStorage()
    // The real McpClientManager classifies a connect failure as temporary
    // ('reconnecting') or permanent ('error'), emits that snapshot, and only
    // then rejects. This fake mirrors that ordering so the service is not
    // allowed to clobber it back into a blanket 'error'.
    let stored: McpServerSnapshot | undefined
    const classifyingManager: McpSettingsManager = {
      async connect(config) {
        stored = {
          id: config.id,
          config,
          status: 'reconnecting',
          tools: [],
          error: '连接暂时中断，可以重试：fetch failed',
        }
        throw new Error('fetch failed')
      },
      async reconnect() {
        throw new Error('not used in this test')
      },
      async disconnect() {
        return undefined
      },
      async remove() {
        return false
      },
      get: () => stored,
      list: () => (stored ? [stored] : []),
      subscribe: () => () => {},
    }
    const service = createMcpSettingsService({
      store,
      manager: classifyingManager,
      storage,
      createId: () => 'flaky',
    })
    store.setter(mcpAddFormOpenAtom, true)
    store.setter(mcpDraftAtom, {
      name: '不稳定服务',
      transport: 'streamable-http',
      url: 'https://flaky.example.com/mcp',
      command: '',
      argsText: '',
      cwd: '',
      autoConnect: true,
    })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      status: 'reconnecting',
      error: '连接暂时中断，可以重试：fetch failed',
    }))
  })

  it('imports the common Playwright JSON in a browser without starting the stdio process', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: false },
      createId: () => 'playwright',
    })

    await expect(service.importJson(PLAYWRIGHT_MCP_JSON)).resolves.toBe(true)

    const expected: PersistedMcpServerConfig = {
      id: 'playwright',
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      autoConnect: false,
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith([expected])
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual([expected])
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({
        id: 'playwright',
        status: 'disconnected',
        toolCount: 0,
      }),
    ])
  })

  it('imports multiple services in one save and leaves every transport manual-only', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const ids = ['local-playwright', 'remote-search']
    let nextId = 0
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
      createId: () => ids[nextId++]!,
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
        search: {
          type: 'http',
          url: 'https://search.example.com/mcp',
        },
      },
    }))).resolves.toBe(true)

    const expected: readonly PersistedMcpServerConfig[] = [
      {
        id: 'local-playwright',
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        autoConnect: false,
      },
      {
        id: 'remote-search',
        name: 'search',
        transport: 'streamable-http',
        url: 'https://search.example.com/mcp',
        autoConnect: false,
      },
    ]
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(expected)
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(expected)
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({ id: 'local-playwright', status: 'disconnected' }),
      expect.objectContaining({ id: 'remote-search', status: 'disconnected' }),
    ])
  })

  it('rejects a case-insensitive name conflict without partially importing the batch', async () => {
    const existing: PersistedMcpServerConfig = {
      id: 'existing-search',
      name: 'Search',
      transport: 'streamable-http',
      url: 'https://existing.example.com/mcp',
      autoConnect: false,
    }
    const store = createStore()
    const { storage, save } = createStorage([existing])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    const configsBefore = store.getter(mcpServerConfigsAtom)
    const serversBefore = store.getter(mcpServersAtom)

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        docs: { url: 'https://docs.example.com/mcp' },
        search: { url: 'https://replacement.example.com/mcp' },
      },
    }))).resolves.toBe(false)

    expect(save).not.toHaveBeenCalled()
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(configsBefore)
    expect(store.getter(mcpServersAtom)).toEqual(serversBefore)
    expect(store.getter(mcpFormErrorAtom)).toContain('同名')
  })

  it('keeps the existing state intact when the atomic import save fails', async () => {
    const existing: PersistedMcpServerConfig = {
      id: 'existing-docs',
      name: '已有文档',
      transport: 'streamable-http',
      url: 'https://existing.example.com/mcp',
      autoConnect: false,
    }
    const store = createStore()
    const { storage, save } = createStorage([existing])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    const configsBefore = store.getter(mcpServerConfigsAtom)
    const serversBefore = store.getter(mcpServersAtom)
    save.mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        imported: { url: 'https://imported.example.com/mcp' },
      },
    }))).resolves.toBe(false)

    expect(save).toHaveBeenCalledTimes(1)
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(configsBefore)
    expect(store.getter(mcpServersAtom)).toEqual(serversBefore)
    expect(store.getter(mcpFormErrorAtom)).toContain('storage unavailable')
  })

  it.each([
    '--api-key=not-safe',
    '--token=not-safe',
    '--clientSecret=not-safe',
    '--header=Authorization: Bearer not-safe',
    'ACCESS_TOKEN=not-safe',
  ])('rejects credential-bearing stdio argument %s before saving or connecting', async (argsText) => {
    const store = createStore()
    const { storage, save } = createStorage()
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
    })
    store.setter(mcpDraftAtom, {
      name: '私有服务',
      transport: 'stdio',
      url: '',
      command: 'private-mcp',
      argsText,
      cwd: '',
      autoConnect: true,
    })

    await expect(service.submitDraft()).resolves.toBe(false)

    expect(save).not.toHaveBeenCalled()
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpFormErrorAtom)).toContain('密钥')
  })

  it('forces a newly selected stdio config to manual-only and connects only after reconnect', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
      createId: () => 'playwright',
    })
    store.setter(mcpDraftAtom, {
      name: 'Playwright MCP',
      transport: 'stdio',
      url: '',
      command: 'npx',
      argsText: '-y\n@playwright/mcp@latest',
      cwd: '',
      // Even a stale/forged draft value cannot opt stdio into startup execution.
      autoConnect: true,
    })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(save).toHaveBeenCalledWith([{
      id: 'playwright',
      name: 'Playwright MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      autoConnect: false,
    }])
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      autoConnect: false,
      status: 'disconnected',
    }))

    await service.reconnect('playwright')

    expect(manager.connectCalls).toEqual([{
      id: 'playwright',
      name: 'Playwright MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    }])
    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      status: 'connected',
      toolCount: 1,
    }))
  })

  it('disconnects and reconnects through the manager, then removes persisted config even if manager returns false', async () => {
    const store = createStore()
    const config: PersistedMcpServerConfig = {
      id: 'manual',
      name: '手动服务',
      transport: 'streamable-http',
      url: 'https://manual.example.com/mcp',
      autoConnect: false,
    }
    const { storage, save } = createStorage([config])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()

    await service.setAutoConnect('manual', true)
    await service.disconnect('manual')
    await service.reconnect('manual')
    await service.remove('manual')

    expect(manager.disconnectCalls).toEqual(['manual'])
    expect(manager.reconnectCalls).toEqual(['manual'])
    expect(manager.removeCalls).toEqual(['manual'])
    expect(store.getter(mcpServerConfigsAtom)).toEqual([])
    expect(save).toHaveBeenLastCalledWith([])

    const neverConnected: PersistedMcpServerConfig = {
      ...config,
      id: 'manager-does-not-know-it',
    }
    const second = createStorage([neverConnected])
    const secondStore = createStore()
    const secondService = createMcpSettingsService({
      store: secondStore,
      manager: new FakeMcpManager(),
      storage: second.storage,
    })
    await secondService.hydrate()
    await secondService.remove(neverConnected.id)

    expect(secondStore.getter(mcpServerConfigsAtom)).toEqual([])
    expect(second.save).toHaveBeenLastCalledWith([])
  })

  it('serializes same-server removal and ignores reconnects queued behind deletion', async () => {
    const store = createStore()
    const config: PersistedMcpServerConfig = {
      id: 'race-safe',
      name: '竞态服务',
      transport: 'streamable-http',
      url: 'https://race.example.com/mcp',
      autoConnect: false,
    }
    const { storage, save } = createStorage([config])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    await service.reconnect(config.id)
    expect(manager.connectCalls).toHaveLength(1)

    let releaseRemove!: () => void
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve
    })
    const removeImmediately = manager.remove.bind(manager)
    manager.remove = vi.fn(async (id: string) => {
      await removeGate
      return removeImmediately(id)
    })

    const removing = service.remove(config.id)
    await vi.waitFor(() => expect(manager.remove).toHaveBeenCalledWith(config.id))
    const reconnecting = service.reconnect(config.id)
    const enabling = service.setAutoConnect(config.id, true)
    releaseRemove()

    await Promise.all([removing, reconnecting, enabling])

    expect(manager.connectCalls).toHaveLength(1)
    expect(manager.reconnectCalls).toHaveLength(0)
    expect(manager.get(config.id)).toBeUndefined()
    expect(store.getter(mcpServerConfigsAtom)).toEqual([])
    expect(save).toHaveBeenLastCalledWith([])
  })

  it('rejects a new service at the persisted limit without saving or connecting', async () => {
    const existing: PersistedMcpServerConfig[] = Array.from(
      { length: MCP_SETTINGS_MAX_SERVERS },
      (_, index) => ({
        id: `existing-${index}`,
        name: `已有服务 ${index}`,
        transport: 'streamable-http',
        url: `https://example.com/mcp/${index}`,
        autoConnect: false,
      }),
    )
    const store = createStore()
    const { storage, save } = createStorage(existing)
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    store.setter(mcpDraftAtom, {
      name: '第 51 个服务',
      transport: 'streamable-http',
      url: 'https://example.com/mcp/overflow',
      command: '',
      argsText: '',
      cwd: '',
      autoConnect: false,
    })

    await expect(service.submitDraft()).resolves.toBe(false)

    expect(save).not.toHaveBeenCalled()
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpFormErrorAtom)).toContain(
      `最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`,
    )
    expect(store.getter(mcpServerConfigsAtom)).toHaveLength(MCP_SETTINGS_MAX_SERVERS)
  })
})
