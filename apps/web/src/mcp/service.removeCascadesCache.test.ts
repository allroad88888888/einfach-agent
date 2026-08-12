// 删除服务时级联清掉它的工具清单缓存（A2）。判据：只有 manager.remove 与落盘都成功
// 才清缓存；任一步失败，配置、连接、缓存都原样留着（不半删）。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { createMcpSettingsService } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import type { McpConfigStorage } from './persistence'
import { mcpServerConfigsAtom } from './state'
import type { McpToolNameCache } from './toolNameCache'
import { createMemoryToolNameCacheStorage } from './toolNameCacheStorage'
import type { PersistedMcpServerConfig } from './types'

function config(id: string): PersistedMcpServerConfig {
  return {
    id,
    name: `服务 ${id}`,
    transport: 'streamable-http',
    url: `https://${id}.example.com/mcp`,
    autoConnect: false,
  }
}

/** 每个用例只关心「这个 serverId 是否还在缓存里」，条目内容本身无关紧要。 */
function cacheFor(serverId: string): McpToolNameCache {
  return {
    [serverId]: {
      tools: [{ name: `mcp__${serverId}__search`, description: '搜索' }],
      toolCount: 1,
      cachedAt: 1_700_000_000_000,
      probeStatus: 'success',
    },
  }
}

describe('MCP 设置服务 · 删除服务级联清缓存（A2）', () => {
  it('manager.remove 与落盘都成功：readToolNameCache 不再含它，底层存储也被回写', async () => {
    const target = config('cached-service')
    const { storage } = createStorage([target])
    const cacheStorage = createMemoryToolNameCacheStorage(cacheFor(target.id))
    const store = createStore()
    const service = createMcpSettingsService({
      store,
      manager: new FakeMcpManager(),
      storage,
      toolNameCacheStorage: cacheStorage,
    })
    await service.hydrate()
    expect(service.readToolNameCache()).toHaveProperty(target.id)

    await service.remove(target.id)

    expect(service.readToolNameCache()).not.toHaveProperty(target.id)
    // 不只是进程内那份快照变了：底层存储也被回写成去掉它之后的那份，不是只改了内存。
    expect(await cacheStorage.load()).not.toHaveProperty(target.id)
  })

  it('manager.remove 抛错：不级联清缓存，配置也仍然留着', async () => {
    const target = config('stubborn-service')
    const { storage } = createStorage([target])
    const cacheStorage = createMemoryToolNameCacheStorage(cacheFor(target.id))
    const failingManager = new FakeMcpManager()
    failingManager.remove = async () => {
      throw new Error('remove failed')
    }
    const store = createStore()
    const service = createMcpSettingsService({
      store,
      manager: failingManager,
      storage,
      toolNameCacheStorage: cacheStorage,
    })
    await service.hydrate()

    await service.remove(target.id)

    expect(service.readToolNameCache()).toHaveProperty(target.id)
    expect(store.getter(mcpServerConfigsAtom)).toEqual([target])
  })

  it('manager.remove 成功但落盘失败：persist 先于清缓存，两者都不该发生', async () => {
    const target = config('unsavable-service')
    const cacheStorage = createMemoryToolNameCacheStorage(cacheFor(target.id))
    const storage: McpConfigStorage = {
      persistence: 'persistent',
      load: async () => [target],
      save: async () => {
        throw new Error('disk full')
      },
    }
    const store = createStore()
    const service = createMcpSettingsService({
      store,
      manager: new FakeMcpManager(),
      storage,
      toolNameCacheStorage: cacheStorage,
    })
    await service.hydrate()

    await service.remove(target.id)

    expect(service.readToolNameCache()).toHaveProperty(target.id)
    expect(store.getter(mcpServerConfigsAtom)).toEqual([target])
  })
})
