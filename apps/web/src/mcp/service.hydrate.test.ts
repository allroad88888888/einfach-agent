import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMcpSettingsService } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import {
  mcpHydrationAtom,
  mcpServerConfigsAtom,
  mcpServersAtom,
} from './state'
import type { PersistedMcpServerConfig } from './types'

const HTTP_AUTO: PersistedMcpServerConfig = {
  id: 'knowledge',
  name: '知识库',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/',
  autoConnect: true,
}

const HTTP_MANUAL: PersistedMcpServerConfig = {
  id: 'docs',
  name: '文档',
  transport: 'streamable-http',
  url: 'https://docs.example.com/mcp',
  autoConnect: false,
}

const STDIO_MANUAL: PersistedMcpServerConfig = {
  id: 'local-files',
  name: '本地文件',
  transport: 'stdio',
  command: 'mcp-files',
  args: ['--root', '/workspace'],
  autoConnect: false,
}

/** 冷启动这一条路径：读盘、登记、按 autoConnect 真连，以及重复调用的合并与重试。 */
describe('MCP settings service · hydrate', () => {
  let manager: FakeMcpManager

  beforeEach(() => {
    manager = new FakeMcpManager()
  })

  it('hydrates once, auto-connects HTTP, and never auto-starts stdio even when its persisted autoConnect is true (H1 data model, H2 gate pending)', async () => {
    const store = createStore()
    const autoStdio: PersistedMcpServerConfig = {
      ...STDIO_MANUAL,
      // H1: this is now a legitimately persistable value, not a hardcoded
      // false. hydrate must still never turn it into a real connection —
      // that requires the H2 confirmation gate — and, just as importantly,
      // must not silently rewrite this back to false on disk either.
      autoConnect: true,
    }
    const { storage, load, save } = createStorage([HTTP_AUTO, autoStdio])
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
    // hydrate must not touch storage at all here: no rewrite-and-resave of
    // the stdio autoConnect value (that was the third hardcoded false H1
    // removed).
    expect(save).not.toHaveBeenCalled()
    expect(store.getter(mcpServerConfigsAtom)).toEqual([HTTP_AUTO, autoStdio])
    expect(store.getter(mcpHydrationAtom)).toEqual({ status: 'ready' })
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({
        id: 'knowledge',
        status: 'connected',
        toolCount: 1,
      }),
      expect.objectContaining({
        id: 'local-files',
        autoConnect: true,
        status: 'disconnected',
        toolCount: 0,
      }),
    ])
  })

  it('registers every configured server with the manager, not only the auto-connected ones', async () => {
    const store = createStore()
    const { storage } = createStorage([HTTP_AUTO, HTTP_MANUAL, STDIO_MANUAL])
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
    })

    await service.hydrate()

    // 判据：冷启动后 connect_mcp_server 找得到【全部】已配置服务——它的准入判据就是
    // manager.get()。在此之前只有 autoConnect 的那批有记录，其余一律 NOT_CONFIGURED。
    expect(manager.registerCalls.map((config) => config.id)).toEqual([
      'knowledge',
      'docs',
      'local-files',
    ])
    for (const id of ['knowledge', 'docs', 'local-files']) {
      expect(manager.get(id)).toBeDefined()
    }
    expect(manager.list().map((server) => server.id)).toEqual([
      'knowledge',
      'docs',
      'local-files',
    ])

    // 登记是登记，连接是连接：只有 autoConnect 的 HTTP 服务真的连上了；
    // 手动的 HTTP 与全部 stdio 都停在「未连接」，本机没有任何进程被启动。
    expect(manager.connectCalls.map((config) => config.id)).toEqual(['knowledge'])
    expect(manager.get('docs')?.status).toBe('disconnected')
    expect(manager.get('local-files')?.status).toBe('disconnected')
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({ id: 'knowledge', status: 'connected', toolCount: 1 }),
      expect.objectContaining({ id: 'docs', status: 'disconnected', toolCount: 0 }),
      expect.objectContaining({ id: 'local-files', status: 'disconnected', toolCount: 0 }),
    ])
  })

  it('registers stdio servers without passing persistence-only fields to the manager', async () => {
    const store = createStore()
    const { storage } = createStorage([STDIO_MANUAL])
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: true },
    })

    await service.hydrate()

    expect(manager.registerCalls).toEqual([{
      id: 'local-files',
      name: '本地文件',
      transport: 'stdio',
      command: 'mcp-files',
      args: ['--root', '/workspace'],
    }])
  })

  it('marks a server that the manager refuses to register instead of failing hydration', async () => {
    const store = createStore()
    const { storage } = createStorage([HTTP_AUTO, HTTP_MANUAL])
    const rejecting = new FakeMcpManager()
    const register = rejecting.register.bind(rejecting)
    rejecting.register = async (config) => {
      if (config.id === 'docs') throw new Error('MCP server id must not be empty')
      return register(config)
    }
    const service = createMcpSettingsService({ store, manager: rejecting, storage })

    await service.hydrate()

    // 一条配置登记不了不该让整次冷启动失败：其余服务照常登记、照常自动连接。
    expect(store.getter(mcpHydrationAtom)).toEqual({ status: 'ready' })
    expect(rejecting.get('knowledge')?.status).toBe('connected')
    expect(rejecting.get('docs')).toBeUndefined()
    expect(store.getter(mcpServersAtom)[1]).toEqual(expect.objectContaining({
      id: 'docs',
      status: 'error',
      error: '配置无法登记：MCP server id must not be empty',
    }))
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
})
