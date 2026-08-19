// 「装配点按宿主态分流」这组用例的共用夹具。
// ---------------------------------------------------------------------------
// 两个用例文件共用（存储通道那半在 `initialize.storage.test.ts`，能力位那半在
// `initialize.capabilities.test.ts`）。`vi.mock` 必须写在各自的用例文件里（它按文件提升），
// 所以本文件只造对象和做 `vi.resetModules()`、不替模块——`freshHost()` 里那几次动态 import
// 拿到的是调用方那个文件登记的替身。
//
// 装配按 `isMcpSettingsConfigured()` 只生效一次，所以每个用例都要先换一套全新模块实例，
// 再让它重新走一遍「按宿主态选通道」。

import { vi } from 'vitest'
import type { ResolvedHost } from '../host/resolveHost'
import type { McpToolNameCache } from './toolNameCache'
import { MCP_TOOL_NAME_CACHE_STORAGE_KEY } from './toolNameCacheStorage'

export const TAURI_HOST: ResolvedHost = { kind: 'tauri' }
export const SERVER_HOST: ResolvedHost = { kind: 'server', platform: 'macos' }
export const STATIC_HOST: ResolvedHost = { kind: 'static', reason: 'unreachable' }

/**
 * 换一套全新模块实例，并把三个替身清干净（`resetModules` 不清替身的调用记录）。
 *
 * 【为什么不再把 `isTauri` 与 `host.kind` 对齐】（C7）对齐这件事本身就是「装配路径上还有第二处
 * 宿主探测」的证据。现在装配点及其调用到的每个工厂都只认递进来的 `host`，所以用例反过来断言
 * `isTauriMock` 一次都没被调用过。
 */
export async function freshHost() {
  vi.resetModules()
  const tauriCore = await import('@tauri-apps/api/core')
  const isTauriMock = vi.mocked(tauriCore.isTauri)
  const invokeMock = vi.mocked(tauriCore.invoke)
  const serverInvokeMock = vi.mocked((await import('../host/serverInvoke')).invokeServerCommand)
  isTauriMock.mockReset()
  invokeMock.mockReset()
  serverInvokeMock.mockReset()
  return { isTauriMock, invokeMock, serverInvokeMock }
}

/** 一条最小的缓存条目，只用来回答「这份缓存是从哪条通道读回来的」。 */
export function cacheFor(serverId: string): McpToolNameCache {
  return {
    [serverId]: {
      tools: [{ name: `mcp__${serverId}__search`, description: '搜索' }],
      toolCount: 1,
      cachedAt: 1_700_000_000_000,
      probeStatus: 'success',
    },
  }
}

/** 往浏览器 localStorage 里放一份缓存。tauri/server 用例拿它当**诱饵**：走岔就会读到它。 */
export function seedBrowserCache(serverId: string): void {
  window.localStorage.setItem(
    MCP_TOOL_NAME_CACHE_STORAGE_KEY,
    JSON.stringify({ version: 1, cache: cacheFor(serverId) }),
  )
}

/** 浏览器里那份缓存现在长什么样（那把键还不存在就是 `undefined`）。 */
export function readBrowserCache(): unknown {
  const raw = window.localStorage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)
  return raw === null ? undefined : (JSON.parse(raw) as { cache: unknown }).cache
}

/** 诱饵那份缓存的 serverId：任何一条命令通道都不会回它。 */
export const DECOY = 'from-local-storage'
