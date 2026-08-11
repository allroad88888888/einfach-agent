// 进程内那一份工具名缓存快照的读出口（B5）。写入侧的不丢写入由 probeOnInstall.test.ts /
// refreshOnConnect.test.ts 覆盖，这里钉的是「读到的和写到的是同一份」这条纪律。

import { describe, expect, it, vi } from 'vitest'
import type { McpToolNameCache } from './toolNameCache'
import {
  createMemoryToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import { createMcpToolNameCacheHandle } from './toolNameCacheWriter'

const CACHED_DOCS: McpToolNameCache = {
  docs: {
    tools: [{ name: 'mcp__docs__search', description: '搜索文档' }],
    toolCount: 1,
    cachedAt: 1_700_000_000_000,
    probeStatus: 'success',
  },
}

/** 一个 save 要等好几个微任务才落地的存储：用来把读-改-写切开。 */
function slowStorage(initial: McpToolNameCache = {}): McpToolNameCacheStorage {
  const inner = createMemoryToolNameCacheStorage(initial)
  return {
    persistence: inner.persistence,
    load: inner.load,
    async save(next) {
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
      await inner.save(next)
    },
  }
}

describe('工具名缓存 handle · 读出口', () => {
  it('还没读盘也没写过时读到空缓存——不是"这些服务没有工具"', () => {
    expect(createMcpToolNameCacheHandle(createMemoryToolNameCacheStorage(CACHED_DOCS)).read())
      .toEqual({})
  })

  it('冷启动 load 之后读到磁盘上那份', async () => {
    const handle = createMcpToolNameCacheHandle(createMemoryToolNameCacheStorage(CACHED_DOCS))

    await handle.load()

    expect(handle.read()).toEqual(CACHED_DOCS)
  })

  it('读到的就是写进去的那一份：写入立刻可见，且是同一个对象引用', async () => {
    const handle = createMcpToolNameCacheHandle(createMemoryToolNameCacheStorage())

    await handle.write('github', {
      tools: [{ name: 'mcp__github__create_issue', description: '新建 issue' }],
      probeStatus: 'success',
      cachedAt: 42,
    })

    expect(handle.read().github).toEqual({
      tools: [{ name: 'mcp__github__create_issue', description: '新建 issue' }],
      toolCount: 1,
      cachedAt: 42,
      probeStatus: 'success',
    })
    // 同一份快照的两次读取拿到同一个引用——读出口不做拷贝，也就没有"第二份缓存"。
    expect(handle.read()).toBe(handle.read())
  })

  it('load 绝不用磁盘上的旧数据盖掉内存里更新的那份', async () => {
    const handle = createMcpToolNameCacheHandle(slowStorage(CACHED_DOCS))

    await handle.write('docs', { tools: [], probeStatus: 'failed', cachedAt: 2_000 })
    await handle.load()

    expect(handle.read().docs).toEqual({
      tools: [], toolCount: 0, cachedAt: 2_000, probeStatus: 'failed',
    })
  })

  it('load 排在同一条队列上，不会插进一次写入的读-改-写中间', async () => {
    const handle = createMcpToolNameCacheHandle(slowStorage(CACHED_DOCS))

    // 写入还没落盘就发起冷启动读盘：load 若不排队，就会读回不含 github 的旧快照并覆盖它。
    const writing = handle.write('github', {
      tools: [{ name: 'mcp__github__create_issue' }], probeStatus: 'success', cachedAt: 7,
    })
    const loading = handle.load()
    await Promise.all([writing, loading])

    expect(Object.keys(handle.read()).sort()).toEqual(['docs', 'github'])
  })

  it('磁盘读不回来时 load 不 reject，读出口回落到空缓存', async () => {
    const load = vi.fn(async () => {
      throw new Error('config file is gone')
    })
    const handle = createMcpToolNameCacheHandle({
      persistence: 'persistent',
      load,
      save: async () => undefined,
    })

    await expect(handle.load()).resolves.toEqual({})
    expect(handle.read()).toEqual({})
    expect(load).toHaveBeenCalledTimes(1)
  })
})
