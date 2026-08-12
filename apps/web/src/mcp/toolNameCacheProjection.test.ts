// 缓存 → 设置面板 atom 的只读投影（B5）。判据：推的是同一份快照、每次写入都推、
// service dispose 之后不再动它的 store。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { mcpLastKnownToolsAtom } from './state'
import { createMcpToolNameCacheProjection } from './toolNameCacheProjection'
import { createMemoryToolNameCacheStorage } from './toolNameCacheStorage'
import type { McpToolNameCache } from './toolNameCache'
import { createMcpToolNameCacheHandle } from './toolNameCacheWriter'

const CACHED_DOCS: McpToolNameCache = {
  docs: {
    tools: [{ name: 'mcp__docs__search', description: '搜索文档' }],
    toolCount: 1,
    cachedAt: 1_700_000_000_000,
    probeStatus: 'success',
  },
}

function setup(initial: McpToolNameCache = {}, active = true) {
  const store = createStore()
  const cache = createMcpToolNameCacheHandle(createMemoryToolNameCacheStorage(initial))
  const projection = createMcpToolNameCacheProjection({
    store,
    cache,
    isActive: () => active,
  })
  return { store, cache, projection }
}

describe('工具名缓存 → 服务视图的投影', () => {
  it('冷启动 load 之后 atom 上就是磁盘那份，且是缓存持有者的同一个对象引用', async () => {
    const { store, cache, projection } = setup(CACHED_DOCS)

    await projection.load()

    expect(store.getter(mcpLastKnownToolsAtom)).toEqual(CACHED_DOCS)
    // 不是拷贝：atom 只是同一份快照的第二个引用，不存在"两份缓存互相漂移"。
    expect(store.getter(mcpLastKnownToolsAtom)).toBe(cache.read())
  })

  it('每次写入都顺手推一次，写入方不需要记得刷新界面', async () => {
    const { store, projection } = setup()

    await projection.write('github', {
      tools: [{ name: 'mcp__github__create_issue' }],
      probeStatus: 'success',
      cachedAt: 42,
    })

    expect(store.getter(mcpLastKnownToolsAtom).github).toEqual(expect.objectContaining({
      toolCount: 1,
      cachedAt: 42,
    }))
  })

  it('remove 之后 atom 也跟着更新，不再含被删的 serverId（A2 级联清理经这层推给界面）', async () => {
    const { store, projection } = setup(CACHED_DOCS)
    await projection.load()

    await projection.remove('docs')

    expect(store.getter(mcpLastKnownToolsAtom)).toEqual({})
  })

  it('service 已经 dispose：缓存照写，但不再回写它那个 store', async () => {
    const { store, cache, projection } = setup({}, false)

    await projection.write('github', {
      tools: [{ name: 'mcp__github__create_issue' }],
      probeStatus: 'success',
      cachedAt: 42,
    })

    expect(cache.read().github).toBeDefined()
    expect(store.getter(mcpLastKnownToolsAtom)).toEqual({})
  })

  it('磁盘读不回来时 load 不 reject，界面停在空缓存', async () => {
    const store = createStore()
    const projection = createMcpToolNameCacheProjection({
      store,
      cache: createMcpToolNameCacheHandle({
        persistence: 'persistent',
        load: async () => {
          throw new Error('config file is gone')
        },
        save: async () => undefined,
      }),
      isActive: () => true,
    })

    await expect(projection.load()).resolves.toBeUndefined()
    expect(store.getter(mcpLastKnownToolsAtom)).toEqual({})
  })
})
