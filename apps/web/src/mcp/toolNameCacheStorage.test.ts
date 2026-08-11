import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import {
  createBrowserToolNameCacheStorage,
  createDesktopToolNameCacheStorage,
  createMemoryToolNameCacheStorage,
  createTauriToolNameCacheStorage,
  createToolNameCacheStorage,
} from './toolNameCacheStorage'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

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

describe('createTauriToolNameCacheStorage', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('reads the toolNameCache key out of the mcp config section', async () => {
    invokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const storage = createTauriToolNameCacheStorage()

    const loaded = await storage.load()

    expect(loaded).toEqual(sampleCache())
    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
  })

  it('treats a missing section or missing key as an empty cache', async () => {
    invokeMock.mockResolvedValueOnce({})
    const storage = createTauriToolNameCacheStorage()

    expect(await storage.load()).toEqual({})
  })

  it('sanitizes whatever the config file reports the same way the in-memory path does', async () => {
    invokeMock.mockResolvedValueOnce({
      toolNameCache: {
        'server-a': {
          tools: [{ name: 'ok' }, { missing: 'name' }],
          toolCount: 1,
          cachedAt: 1,
          probeStatus: 'success',
        },
        'server-b': { tools: [], toolCount: 0, cachedAt: 1, probeStatus: 'not-a-real-status' },
      },
    })
    const storage = createTauriToolNameCacheStorage()

    const loaded = await storage.load()

    expect(loaded['server-a']?.tools).toEqual([{ name: 'ok', description: '' }])
    expect(loaded['server-b']).toBeUndefined()
  })

  it('writes the sanitized cache under the toolNameCache key via mcp_config_write', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    const storage = createTauriToolNameCacheStorage()

    await storage.save(sampleCache())

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_write', {
      patch: { toolNameCache: sampleCache() },
    })
  })

  it('degrades a failed read into a normalized error', async () => {
    invokeMock.mockRejectedValueOnce('磁盘不可读')
    const storage = createTauriToolNameCacheStorage()

    await expect(storage.load()).rejects.toThrow('无法读取 MCP 工具名缓存：磁盘不可读')
  })

  it('degrades a failed write into a normalized error', async () => {
    invokeMock.mockRejectedValueOnce('mcp 配置段格式无效')
    const storage = createTauriToolNameCacheStorage()

    await expect(storage.save(sampleCache())).rejects.toThrow(
      '无法保存 MCP 工具名缓存：mcp 配置段格式无效',
    )
  })
})

describe('createDesktopToolNameCacheStorage', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    window.localStorage.clear()
  })

  it('falls back to the browser implementation when no Tauri host is present', async () => {
    isTauriMock.mockReturnValue(false)
    const storage = createDesktopToolNameCacheStorage()

    await storage.save(sampleCache())

    expect(await storage.load()).toEqual(sampleCache())
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('uses the Tauri config command channel when a Tauri host is present', async () => {
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const storage = createDesktopToolNameCacheStorage()

    expect(await storage.load()).toEqual(sampleCache())
    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
  })
})
