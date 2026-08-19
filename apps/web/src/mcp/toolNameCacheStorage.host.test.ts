// 工具名缓存走**配置文件**的那两条通道，以及"按宿主选哪一条"（C7）。
//
//   · `tauri`  —— `mcp_config_read` / `mcp_config_write`（Tauri 原生命令）
//   · `server` —— 同一对命令名，但走 `POST /api/invoke/:command`（本机 Node 后端）
//
// 两条落的是**同一份** `~/.webAgent/config.json` 的 `mcp.toolNameCache` 键，所以段语义
// （取键、清洗、两句错误话术）必须逐字相同；下面两个 describe 是对照着写的。
// 三条本地通道（内存 / StorageLike / 浏览器）在 toolNameCacheStorage.test.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ResolvedHost } from '../host/resolveHost'
import { invokeServerCommand } from '../host/serverInvoke'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import {
  createServerToolNameCacheStorage,
  createTauriToolNameCacheStorage,
  createToolNameCacheStorageForHost,
  MCP_TOOL_NAME_CACHE_STORAGE_KEY,
} from './toolNameCacheStorage'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

// server 那一态的传输面。只替 `invokeServerCommand`——其余导出保留真身。
vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)
const serverInvokeMock = vi.mocked(invokeServerCommand)

function sampleCache(): McpToolNameCache {
  return setToolNameCacheEntry({}, 'server-a', {
    tools: [{ name: 'read_file', description: '读取文件内容' }],
    probeStatus: 'success',
    cachedAt: 1000,
  })
}

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

// server 宿主那条通道：命令名、键、清洗、错误话术与桌面那条逐字相同，只差一次传输
// （`invoke` → `POST /api/invoke/:command`）。所以这里只钉住"传输确实换了、段语义没换"。
describe('createServerToolNameCacheStorage', () => {
  beforeEach(() => {
    serverInvokeMock.mockReset()
    invokeMock.mockReset()
  })

  it('reads the toolNameCache key through POST /api/invoke/mcp_config_read', async () => {
    serverInvokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const storage = createServerToolNameCacheStorage()

    const loaded = await storage.load()

    expect(loaded).toEqual(sampleCache())
    // 无参命令：第二个实参显式是 undefined（serverMcpConfigStorage.ts 的同款记档）。
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    // server 宿主里没有 Tauri 原生层：一次都不该碰它。
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('treats a missing section or missing key as an empty cache', async () => {
    serverInvokeMock.mockResolvedValueOnce({})
    const storage = createServerToolNameCacheStorage()

    expect(await storage.load()).toEqual({})
  })

  it('sanitizes whatever the backend reports the same way the desktop path does', async () => {
    serverInvokeMock.mockResolvedValueOnce({
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
    const storage = createServerToolNameCacheStorage()

    const loaded = await storage.load()

    expect(loaded['server-a']?.tools).toEqual([{ name: 'ok', description: '' }])
    expect(loaded['server-b']).toBeUndefined()
  })

  it('writes the sanitized cache under the toolNameCache key via mcp_config_write', async () => {
    serverInvokeMock.mockResolvedValueOnce(undefined)
    const storage = createServerToolNameCacheStorage()

    await storage.save(sampleCache())

    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_write', {
      patch: { toolNameCache: sampleCache() },
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('degrades a failed read into the same normalized error the desktop path uses', async () => {
    serverInvokeMock.mockRejectedValueOnce(new Error('无法连接本地服务：fetch failed'))
    const storage = createServerToolNameCacheStorage()

    await expect(storage.load()).rejects.toThrow(
      '无法读取 MCP 工具名缓存：无法连接本地服务：fetch failed',
    )
  })

  it('degrades a failed write into the same normalized error the desktop path uses', async () => {
    serverInvokeMock.mockRejectedValueOnce('mcp 配置段格式无效')
    const storage = createServerToolNameCacheStorage()

    await expect(storage.save(sampleCache())).rejects.toThrow(
      '无法保存 MCP 工具名缓存：mcp 配置段格式无效',
    )
  })
})

/**
 * 按宿主选通道（C7）。**判据是"哪条通道真的被用了"，不是"工厂被调用过"**：
 * 后者只证明写了那行代码，前者证明这条路走得通。
 *
 * 三个用例外加一条共同断言：**`isTauri()` 一次都不该被调用**。这是本卡的结构性判据——
 * 宿主态的唯一权威是 `resolveHost()`，这里再探一次的后果不是报错，是两处结论不同时静默走岔
 * （server 宿主下 `isTauri()` 答 false，缓存于是落进浏览器 localStorage，而服务配置进了
 * `~/.webAgent/config.json`）。
 */
describe('createToolNameCacheStorageForHost', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    serverInvokeMock.mockReset()
    isTauriMock.mockReset()
    window.localStorage.clear()
  })

  it('tauri 宿主 → Tauri 配置文件通道', async () => {
    invokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const host: ResolvedHost = { kind: 'tauri' }

    const storage = createToolNameCacheStorageForHost(host)

    expect(await storage.load()).toEqual(sampleCache())
    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    expect(serverInvokeMock).not.toHaveBeenCalled()
    expect(isTauriMock).not.toHaveBeenCalled()
  })

  it('server 宿主 → HTTP 配置文件通道（同一份配置文件，不是 localStorage）', async () => {
    serverInvokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const host: ResolvedHost = { kind: 'server', platform: 'macos' }

    const storage = createToolNameCacheStorageForHost(host)

    expect(await storage.load()).toEqual(sampleCache())
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(isTauriMock).not.toHaveBeenCalled()
    // 落盘那一半也必须走同一条通道，不能只有读对了。
    await storage.save(sampleCache())
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_write', {
      patch: { toolNameCache: sampleCache() },
    })
    expect(window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)).toBeNull()
  })

  it('static 宿主 → 浏览器 localStorage，两条命令通道都不碰', async () => {
    const host: ResolvedHost = { kind: 'static', reason: 'unreachable' }

    const storage = createToolNameCacheStorageForHost(host)
    await storage.save(sampleCache())

    expect(await storage.load()).toEqual(sampleCache())
    expect(window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)).not.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(serverInvokeMock).not.toHaveBeenCalled()
    expect(isTauriMock).not.toHaveBeenCalled()
  })
})
