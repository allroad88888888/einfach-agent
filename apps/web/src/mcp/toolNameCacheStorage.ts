import { invoke, isTauri } from '@tauri-apps/api/core'
import type { McpPersistenceMode } from './types'
import { isPlainRecord, sanitizeToolNameCache, type McpToolNameCache } from './toolNameCache'

// 工具名缓存的读写通道：内存（测试/降级）、浏览器 localStorage、Tauri 配置文件。
// 数据形状与限额清洗规则都在 toolNameCache.ts；这里只负责"读回来之后交给清洗，
// 清洗完之后写出去"，与 persistence.ts / tauriMcpConfigStorage.ts 对 servers 列表
// 的处理方式对称。写入落在 app 层——tools/mcp 与 packages/agent-core 都不碰磁盘。

export interface McpToolNameCacheStorage {
  readonly persistence: McpPersistenceMode
  load(): Promise<McpToolNameCache>
  save(cache: McpToolNameCache): Promise<void>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const MCP_TOOL_NAME_CACHE_STORAGE_KEY = 'web-agent.mcp-tool-name-cache.v1'

interface ToolNameCacheEnvelope {
  version: 1
  cache: unknown
}

function parseEnvelope(raw: string): McpToolNameCache {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (isPlainRecord(parsed) && parsed.version === 1) {
    return sanitizeToolNameCache((parsed as ToolNameCacheEnvelope).cache)
  }
  return {}
}

export function createToolNameCacheStorage(storage: StorageLike): McpToolNameCacheStorage {
  return {
    persistence: 'persistent',
    async load() {
      const raw = storage.getItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY)
      if (!raw) return {}
      return parseEnvelope(raw)
    },
    async save(cache) {
      const safeCache = sanitizeToolNameCache(cache)
      const envelope: ToolNameCacheEnvelope = { version: 1, cache: safeCache }
      storage.setItem(MCP_TOOL_NAME_CACHE_STORAGE_KEY, JSON.stringify(envelope))
    },
  }
}

export function createMemoryToolNameCacheStorage(
  initial: McpToolNameCache = {},
): McpToolNameCacheStorage {
  let cache = sanitizeToolNameCache(initial)
  return {
    persistence: 'temporary',
    load: async () => cache,
    async save(next) {
      cache = sanitizeToolNameCache(next)
    },
  }
}

export function createBrowserToolNameCacheStorage(): McpToolNameCacheStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return createToolNameCacheStorage(window.localStorage)
    }
  } catch {
    // Sandboxed browsers may expose localStorage but throw while accessing it.
  }
  return createMemoryToolNameCacheStorage()
}

// Distinct top-level key inside the same `mcp` config section that
// tauriMcpConfigStorage.ts writes `servers` into (see mcp_config.rs: the
// section is a plain object, each concern gets its own top-level key).
const MCP_CONFIG_TOOL_NAME_CACHE_KEY = 'toolNameCache'

function extractToolNameCacheSection(section: unknown): unknown {
  if (!isPlainRecord(section)) return undefined
  return section[MCP_CONFIG_TOOL_NAME_CACHE_KEY]
}

function describeError(prefix: string, error: unknown): Error {
  if (error instanceof Error && error.message.trim()) {
    return new Error(`${prefix}：${error.message}`)
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(`${prefix}：${error}`)
  }
  return new Error(prefix)
}

/**
 * 读写走 A3 打通的 mcp_config_read / mcp_config_write 两个 Tauri command
 * （apps/desktop/src/mcp_config.rs），落在 ~/.webAgent/config.json 的
 * mcp.toolNameCache 键下。写入是 mcp_config_write 的合并语义，只替换这个键，
 * 不影响同一段里的 servers 等其它键。
 */
export function createTauriToolNameCacheStorage(): McpToolNameCacheStorage {
  return {
    persistence: 'persistent',
    async load() {
      let section: unknown
      try {
        section = await invoke('mcp_config_read')
      } catch (error) {
        throw describeError('无法读取 MCP 工具名缓存', error)
      }
      return sanitizeToolNameCache(extractToolNameCacheSection(section))
    },
    async save(cache) {
      const safeCache = sanitizeToolNameCache(cache)
      try {
        await invoke('mcp_config_write', {
          patch: { [MCP_CONFIG_TOOL_NAME_CACHE_KEY]: safeCache },
        })
      } catch (error) {
        throw describeError('无法保存 MCP 工具名缓存', error)
      }
    },
  }
}

/**
 * 桌面端优先存储：有 Tauri host 时走配置文件通道，否则退回浏览器/内存实现
 * （浏览器、测试）。
 */
export function createDesktopToolNameCacheStorage(): McpToolNameCacheStorage {
  if (!isTauri()) return createBrowserToolNameCacheStorage()
  return createTauriToolNameCacheStorage()
}
