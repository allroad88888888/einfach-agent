// 冷启动把工具名缓存读进服务视图（B5），以及它此后怎么跟着缓存走。
//
// 判据落在 mcpServersAtom 上而不是某个内部函数上：UI 只能读 atom，所以「界面上看得到」
// 这件事在这一层就要成立。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { createMemoryMcpConfigStorage } from './persistence'
import { createMcpSettingsService } from './service'
import { FakeMcpManager } from './service.fixtures'
import { mcpLastKnownToolsAtom, mcpServersAtom } from './state'
import type { McpToolNameCache } from './toolNameCache'
import { createMemoryToolNameCacheStorage } from './toolNameCacheStorage'
import type { PersistedMcpServerConfig } from './types'

const CACHED_AT = 1_700_000_000_000

const DOCS: PersistedMcpServerConfig = {
  id: 'docs',
  name: '文档',
  transport: 'streamable-http',
  url: 'https://docs.example.com/mcp',
  autoConnect: false,
}

const NOTES: PersistedMcpServerConfig = {
  id: 'notes',
  name: '笔记',
  transport: 'streamable-http',
  url: 'https://notes.example.com/mcp',
  autoConnect: false,
}

const CACHE: McpToolNameCache = {
  docs: {
    tools: [
      { name: 'mcp__docs__search', description: '搜索文档' },
      { name: 'mcp__docs__draft', description: '起草文档' },
    ],
    toolCount: 2,
    cachedAt: CACHED_AT,
    probeStatus: 'success',
  },
  // 探测过、当时确实一个工具都没有——与「从未探测过」是两回事，两者都要能表达。
  empty: {
    tools: [],
    toolCount: 0,
    cachedAt: CACHED_AT,
    probeStatus: 'success',
  },
}

function setup(
  configs: readonly PersistedMcpServerConfig[],
  initialCache: McpToolNameCache = CACHE,
) {
  const store = createStore()
  const manager = new FakeMcpManager()
  const cacheStorage = createMemoryToolNameCacheStorage(initialCache)
  const service = createMcpSettingsService({
    store,
    manager,
    storage: createMemoryMcpConfigStorage(configs),
    toolNameCacheStorage: cacheStorage,
  })
  const serverView = (id: string) =>
    store.getter(mcpServersAtom).find((entry) => entry.id === id)
  return { store, manager, cacheStorage, service, serverView }
}

describe('MCP 设置 · 冷启动读缓存进服务视图', () => {
  it('未连接的服务带上上次已知的清单与探测时刻', async () => {
    const { service, serverView } = setup([DOCS])

    await service.hydrate()

    expect(serverView('docs')).toEqual(expect.objectContaining({
      status: 'disconnected',
      // 当前连接的工具数（真实为 0，因为没连上）与历史清单是两个字段，不互相污染。
      toolCount: 0,
      lastKnownTools: {
        serverId: 'docs',
        tools: [
          { name: 'mcp__docs__search', description: '搜索文档' },
          { name: 'mcp__docs__draft', description: '起草文档' },
        ],
        toolCount: 2,
        truncated: false,
        cachedAt: CACHED_AT,
        probeStatus: 'success',
      },
    }))
  })

  it('从未探测过的服务【没有】这个字段——不能伪造成「探测到 0 个工具」', async () => {
    const { service, serverView } = setup([DOCS, NOTES])

    await service.hydrate()

    expect(serverView('notes')?.lastKnownTools).toBeUndefined()
    // 而「探测过、结果是 0 个」必须留得下痕迹，两者在数据层就已经分开。
    const { service: other, serverView: otherView } = setup([{ ...NOTES, id: 'empty' }])
    await other.hydrate()
    expect(otherView('empty')?.lastKnownTools).toEqual(expect.objectContaining({
      toolCount: 0,
      cachedAt: CACHED_AT,
      probeStatus: 'success',
    }))
  })

  it('hydrate 之前界面上什么都没有：缓存还没读，不代表服务没有工具', () => {
    const { store } = setup([DOCS])

    expect(store.getter(mcpLastKnownToolsAtom)).toEqual({})
  })

  it('连上之后刷新的新清单立刻进服务视图，不用等下次冷启动', async () => {
    const { service, serverView } = setup([{ ...DOCS, autoConnect: true }])

    await service.hydrate()

    // FakeMcpManager 连上后只报一个 search 工具：视图上的历史跟着换成这一份。
    expect(serverView('docs')?.lastKnownTools?.tools).toEqual([
      { name: 'mcp__docs__search', description: 'Search' },
    ])
    expect(serverView('docs')?.status).toBe('connected')
  })

  it('磁盘缓存读不回来时冷启动照常完成，界面只是没有历史可显示', async () => {
    const store = createStore()
    const service = createMcpSettingsService({
      store,
      manager: new FakeMcpManager(),
      storage: createMemoryMcpConfigStorage([DOCS]),
      toolNameCacheStorage: {
        persistence: 'persistent',
        load: async () => {
          throw new Error('config file is gone')
        },
        save: async () => undefined,
      },
    })

    await service.hydrate()

    expect(store.getter(mcpServersAtom)[0]?.lastKnownTools).toBeUndefined()
    expect(store.getter(mcpServersAtom)[0]?.name).toBe('文档')
  })

})

describe('MCP 设置 · 缓存读出口与连接状态（B4/F4 的取数口）', () => {
  it('readToolNameCache 交出的就是写入点持有的那一份', async () => {
    const { service } = setup([DOCS])

    await service.hydrate()

    expect(service.readToolNameCache()).toEqual(CACHE)
  })

  it('isServerConnected 以 manager 的登记表为准，连上前后都答得对', async () => {
    const { service } = setup([{ ...DOCS, autoConnect: false }])
    await service.hydrate()

    expect(service.isServerConnected('docs')).toBe(false)

    await service.reconnect('docs')

    expect(service.isServerConnected('docs')).toBe(true)
    expect(service.isServerConnected('unknown')).toBe(false)
  })
})
