import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSnapshot } from '@einfach-agent/tools-mcp'
import { mcpPendingLaunchConsentsAtom } from './launchConsentState'
import { createMcpSettingsService, type McpSettingsManager } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import {
  MCP_SETTINGS_MAX_SERVERS,
  type McpConfigStorage,
} from './persistence'
import {
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpServerConfigsAtom,
  mcpServersAtom,
} from './state'
import type { PersistedMcpServerConfig } from './types'

describe('MCP settings service', () => {
  let manager: FakeMcpManager

  beforeEach(() => {
    manager = new FakeMcpManager()
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
      async register(config) {
        stored = { id: config.id, config, status: 'disconnected', tools: [] }
        return stored
      },
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

  it('persists a forged stdio autoConnect:true (H1) but never connects on save, and an explicit reconnect only asks for launch consent (H2)', async () => {
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
      // The form defaults this to false when switching to stdio, but a
      // stale/forged draft value must still be storable as-is (H1) without
      // submitDraft using it to start a local process: a brand new config
      // never carries a launch consent, so nothing may run yet (H2).
      autoConnect: true,
    })

    await expect(service.submitDraft()).resolves.toBe(true)

    expect(save).toHaveBeenCalledWith([{
      id: 'playwright',
      name: 'Playwright MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      autoConnect: true,
    }])
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      autoConnect: true,
      status: 'disconnected',
    }))

    // 「重连」也不是起进程的授权：它只把将执行的命令行摆出来等确认（H2）。
    await service.reconnect('playwright')

    expect(manager.connectCalls).toHaveLength(0)
    expect(manager.reconnectCalls).toHaveLength(0)
    expect(store.getter(mcpPendingLaunchConsentsAtom).playwright).toEqual(
      expect.objectContaining({
        commandLine: 'npx -y @playwright/mcp@latest',
        reason: 'connect',
      }),
    )

    await service.approveLaunch('playwright')

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
    // 冷启动会登记全部服务，所以真实 manager 现在总是认得它。这里强制 remove 回 false，
    // 守住原本的回归点：manager 说「我没这个服务」也必须把持久化配置删干净。
    const forgetfulManager = new FakeMcpManager()
    forgetfulManager.remove = async () => false
    const secondService = createMcpSettingsService({
      store: secondStore,
      manager: forgetfulManager,
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
    // 冷启动已经把它登记进 manager，所以「重连」走 manager.reconnect（配置留在 manager
    // 内部），不再由 service 递一份配置进 connect。
    expect(manager.reconnectCalls).toEqual([config.id])
    expect(manager.connectCalls).toHaveLength(0)

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

    // 排在删除后面的重连与「打开自动连接」都不该把服务连回来。
    expect(manager.connectCalls).toHaveLength(0)
    expect(manager.reconnectCalls).toHaveLength(1)
    expect(manager.get(config.id)).toBeUndefined()
    expect(store.getter(mcpServerConfigsAtom)).toEqual([])
    expect(save).toHaveBeenLastCalledWith([])
  })

  it('does not lose a concurrent write to a different server while persisting', async () => {
    // Regression test for a data-loss race: enqueueServerOperation only
    // serializes by serverId, so remove(A) and setAutoConnect(B) run
    // concurrently. storage.save() below models the yield point a real
    // a host IPC round trip opens (every call takes several microtask ticks)
    // -- comfortably longer than either operation's own synchronous
    // "read the atom, compute next" step, so both operations' reads land
    // before either one's write. A correct implementation must still queue
    // the two read-modify-write turns so neither clobbers the other; the
    // bug this guards against was persist() reading store.getter() at the
    // call site (or otherwise outside a shared critical section) and letting
    // whichever storage.save() call resolved last commit a "next" list
    // computed from a stale pre-image, silently dropping the other change.
    const configA: PersistedMcpServerConfig = {
      id: 'race-a',
      name: 'A 服务',
      transport: 'streamable-http',
      url: 'https://a.example.com/mcp',
      autoConnect: false,
    }
    const configB: PersistedMcpServerConfig = {
      id: 'race-b',
      name: 'B 服务',
      transport: 'streamable-http',
      url: 'https://b.example.com/mcp',
      autoConnect: false,
    }
    let persistedConfigs: readonly PersistedMcpServerConfig[] = [configA, configB]
    const load = vi.fn<McpConfigStorage['load']>(async () => persistedConfigs)
    const save = vi.fn<McpConfigStorage['save']>(async (next) => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
      persistedConfigs = [...next]
    })
    const storage: McpConfigStorage = { persistence: 'persistent', load, save }
    const store = createStore()
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()

    await Promise.all([
      service.remove('race-a'),
      service.setAutoConnect('race-b', true),
    ])

    const finalConfigs = store.getter(mcpServerConfigsAtom)
    expect(finalConfigs.find((config) => config.id === 'race-a')).toBeUndefined()
    expect(finalConfigs.find((config) => config.id === 'race-b')).toEqual({
      ...configB,
      autoConnect: true,
    })
    expect(persistedConfigs.find((config) => config.id === 'race-a')).toBeUndefined()
    expect(persistedConfigs.find((config) => config.id === 'race-b')).toEqual({
      ...configB,
      autoConnect: true,
    })
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
