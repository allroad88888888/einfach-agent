// 工具名缓存的三条**本地**通道：内存（测试/降级）、任意 StorageLike、浏览器 localStorage。
// 走配置文件的那两条（Tauri / server）以及"按宿主选哪一条"在 toolNameCacheStorage.host.test.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import {
  createBrowserToolNameCacheStorage,
  createMemoryToolNameCacheStorage,
  createToolNameCacheStorage,
} from './toolNameCacheStorage'

function sampleCache(): McpToolNameCache {
  return setToolNameCacheEntry({}, 'server-a', {
    tools: [{ name: 'read_file', description: '读取文件内容' }],
    probeStatus: 'success',
    cachedAt: 1000,
  })
}

describe('createMemoryToolNameCacheStorage', () => {
  it('round-trips a saved cache and reports temporary persistence', async () => {
    const storage = createMemoryToolNameCacheStorage()

    await storage.save(sampleCache())

    expect(await storage.load()).toEqual(sampleCache())
    expect(storage.persistence).toBe('temporary')
  })

  it('returns an empty cache for a server that was never cached (missing service)', async () => {
    const storage = createMemoryToolNameCacheStorage(sampleCache())

    const loaded = await storage.load()

    expect(loaded['no-such-server']).toBeUndefined()
  })
})

describe('createToolNameCacheStorage (StorageLike, e.g. localStorage)', () => {
  it('round-trips a saved cache through a versioned envelope', async () => {
    let stored: string | null = null
    const storage = createToolNameCacheStorage({
      getItem: () => stored,
      setItem: (_key, value) => {
        stored = value
      },
    })

    await storage.save(sampleCache())

    expect(await storage.load()).toEqual(sampleCache())
    expect(storage.persistence).toBe('persistent')
  })

  it('returns an empty cache when nothing has been stored yet', async () => {
    const storage = createToolNameCacheStorage({ getItem: () => null, setItem: vi.fn() })

    expect(await storage.load()).toEqual({})
  })

  it('degrades corrupted JSON into an empty cache instead of throwing', async () => {
    const storage = createToolNameCacheStorage({
      getItem: () => '{not valid json',
      setItem: vi.fn(),
    })

    await expect(storage.load()).resolves.toEqual({})
  })

  it('degrades an envelope with an unrecognized version into an empty cache', async () => {
    const storage = createToolNameCacheStorage({
      getItem: () => JSON.stringify({ version: 2, cache: sampleCache() }),
      setItem: vi.fn(),
    })

    await expect(storage.load()).resolves.toEqual({})
  })
})

describe('createBrowserToolNameCacheStorage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('uses localStorage when it is available', async () => {
    const storage = createBrowserToolNameCacheStorage()

    await storage.save(sampleCache())

    expect(storage.persistence).toBe('persistent')
    expect(await storage.load()).toEqual(sampleCache())
  })

  it('falls back to an in-memory cache when localStorage throws', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })

    try {
      const storage = createBrowserToolNameCacheStorage()
      expect(storage.persistence).toBe('temporary')
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
    }
  })
})
