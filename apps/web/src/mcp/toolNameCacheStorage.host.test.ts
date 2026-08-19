// 工具名缓存走**配置文件**那条通道（`mcp_config_read` / `mcp_config_write` 经
// `POST /api/invoke/:command` 打到本机 Node 后端），以及"按宿主选哪一条"（C7）。
//
// 【T1 删掉了什么】此前这里有两个 describe，因为同一对命令名有两条传输：桌面原生 `invoke` 与
// server 的 HTTP。两者落的是同一份 `~/.webAgent/config.json`，所以段语义（取键、清洗、两句错误
// 话术）必须逐字相同，那两个 describe 是**对照着写的**。桌面端退出后只剩一条传输，对照组随之
// 删掉；段语义本身仍由下面这一组逐条钉住——它现在是这份契约在前端侧的唯一权威。
//
// 三条本地通道（内存 / StorageLike / 浏览器）在 toolNameCacheStorage.test.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from '../host/resolveHost'
import { invokeServerCommand } from '../host/serverInvoke'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import {
  createServerToolNameCacheStorage,
  createToolNameCacheStorageForHost,
  MCP_TOOL_NAME_CACHE_STORAGE_KEY,
} from './toolNameCacheStorage'

// server 那一态的传输面。只替 `invokeServerCommand`——其余导出保留真身。
vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const serverInvokeMock = vi.mocked(invokeServerCommand)

function sampleCache(): McpToolNameCache {
  return setToolNameCacheEntry({}, 'server-a', {
    tools: [{ name: 'read_file', description: '读取文件内容' }],
    probeStatus: 'success',
    cachedAt: 1000,
  })
}

// server 宿主那条通道：命令名、键、清洗、两句错误话术逐条钉住。
describe('createServerToolNameCacheStorage', () => {
  beforeEach(() => {
    serverInvokeMock.mockReset()
  })

  it('reads the toolNameCache key through POST /api/invoke/mcp_config_read', async () => {
    serverInvokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const storage = createServerToolNameCacheStorage()

    const loaded = await storage.load()

    expect(loaded).toEqual(sampleCache())
    // 无参命令：第二个实参显式是 undefined（serverMcpConfigStorage.ts 的同款记档）。
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
  })

  it('treats a missing section or missing key as an empty cache', async () => {
    serverInvokeMock.mockResolvedValueOnce({})
    const storage = createServerToolNameCacheStorage()

    expect(await storage.load()).toEqual({})
  })

  it('sanitizes whatever the backend reports the same way the in-memory path does', async () => {
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
  })

  it('degrades a failed read into a normalized error', async () => {
    serverInvokeMock.mockRejectedValueOnce(new Error('无法连接本地服务：fetch failed'))
    const storage = createServerToolNameCacheStorage()

    await expect(storage.load()).rejects.toThrow(
      '无法读取 MCP 工具名缓存：无法连接本地服务：fetch failed',
    )
  })

  it('degrades a failed write into a normalized error', async () => {
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
 * 判据只有递进来的 `host`，本函数不再自己探一次宿主——两处结论不同时的后果不是报错，是静默
 * 走岔（服务配置进了 `~/.webAgent/config.json`，缓存却落进浏览器 localStorage，两份状态分家）。
 */
describe('createToolNameCacheStorageForHost', () => {
  beforeEach(() => {
    serverInvokeMock.mockReset()
    window.localStorage.clear()
  })

  it('server 宿主 → HTTP 配置文件通道（配置文件，不是 localStorage）', async () => {
    serverInvokeMock.mockResolvedValueOnce({ toolNameCache: sampleCache() })
    const host: ResolvedHost = { kind: 'server', platform: 'macos' }

    const storage = createToolNameCacheStorageForHost(host)

    expect(await storage.load()).toEqual(sampleCache())
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    // 落盘那一半也必须走同一条通道，不能只有读对了。
    await storage.save(sampleCache())
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_write', {
      patch: { toolNameCache: sampleCache() },
    })
    expect(window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)).toBeNull()
  })

  it('static 宿主 → 浏览器 localStorage，命令通道一次都不碰', async () => {
    const host: ResolvedHost = { kind: 'static', reason: 'unreachable' }

    const storage = createToolNameCacheStorageForHost(host)
    await storage.save(sampleCache())

    expect(await storage.load()).toEqual(sampleCache())
    expect(window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)).not.toBeNull()
    expect(serverInvokeMock).not.toHaveBeenCalled()
  })
})
