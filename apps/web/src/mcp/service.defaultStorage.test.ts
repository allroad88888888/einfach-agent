// service 不传 `toolNameCacheStorage` 时的默认通道：**浏览器 localStorage，且一次宿主探测都不做**（C7）。
//
// service 拿不到 `ResolvedHost`——它只有装配点递下来的东西。所以默认值只能取"没有本机能力时也
// 成立"的那条通道；按宿主选通道的判据只有装配点一处（`initialize.ts` 的
// `createConfigStorageForHost` / `createToolNameCacheStorageForHost`）。
//
// 【为什么这条必须单独有人守】此前默认值是 `createDesktopToolNameCacheStorage()`，它自己
// `isTauri()` 再探一次——server 宿主下答 false，于是服务配置进了 `~/.webAgent/config.json`、
// 工具名缓存落进浏览器 localStorage，两份状态分家且**不报错**。改回一个会探测的默认值同样是
// 静默的：生产装配点总会显式传一个，装配那组用例一条都不会红。所以判据取"默认值自己的行为"，
// 而 `isTauri()` 的替身在这里**故意答 true**——旧默认值一碰它就会拐进 Tauri 配置文件通道。

import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { createMcpSettingsService } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import { MCP_TOOL_NAME_CACHE_STORAGE_KEY } from './toolNameCacheStorage'
import type { PersistedMcpServerConfig } from './types'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  // 故意答 true：见文件头。默认值只要还探一次宿主，这里就会拐走。
  isTauri: vi.fn(() => true),
}))

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

const SEEDED: PersistedMcpServerConfig = {
  id: 'seeded',
  name: '上次装过的服务',
  transport: 'streamable-http',
  url: 'https://seeded.example.test/mcp',
  autoConnect: false,
}

function readBrowserCache(): unknown {
  const raw = window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)
  return raw === null ? undefined : (JSON.parse(raw) as { cache: unknown }).cache
}

describe('MCP 设置服务 · 工具名缓存的默认通道', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockClear()
    window.localStorage.clear()
  })

  it('不传 toolNameCacheStorage 时读写都落浏览器 localStorage，且从不探测宿主', async () => {
    window.localStorage.setItem(
      MCP_TOOL_NAME_CACHE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        cache: {
          [SEEDED.id]: {
            tools: [{ name: 'mcp__seeded__search', description: '搜索' }],
            toolCount: 1,
            cachedAt: 1_700_000_000_000,
            probeStatus: 'success',
          },
        },
      }),
    )
    const { storage } = createStorage([SEEDED])
    const service = createMcpSettingsService({
      store: createStore(),
      manager: new FakeMcpManager(),
      storage,
    })

    await service.hydrate()
    // 读回来的是 localStorage 里那份，不是任何一条命令通道答的。
    expect(Object.keys(service.readToolNameCache())).toEqual([SEEDED.id])

    // 写回去的那一半同样落浏览器：删除级联清缓存（A2）改的是 localStorage。
    await service.remove(SEEDED.id)
    expect(readBrowserCache()).toEqual({})

    expect(invokeMock).not.toHaveBeenCalled()
    expect(isTauriMock).not.toHaveBeenCalled()
  })
})
