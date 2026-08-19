import { invoke } from '@tauri-apps/api/core'
import type { McpPersistenceMode } from './types'
import { isPlainRecord, sanitizeToolNameCache, type McpToolNameCache } from './toolNameCache'
import { invokeServerCommand } from '../host/serverInvoke'
import type { ResolvedHost } from '../host/resolveHost'

// 工具名缓存的读写通道：内存（测试/降级）、浏览器 localStorage、以及**同一份配置文件**的
// 两条传输（Tauri 原生 invoke / 本机 Node 后端的 HTTP）。数据形状与限额清洗规则都在
// toolNameCache.ts；这里只负责"读回来之后交给清洗，清洗完之后写出去"，与 persistence.ts /
// tauriMcpConfigStorage.ts / serverMcpConfigStorage.ts 对 servers 列表的处理方式对称。
// 写入落在 app 层——tools/mcp 与 packages/agent-core 都不碰磁盘。
//
// 【为什么按宿主选通道的那个函数也在这里】它收 `ResolvedHost`，不自己探（C7）：宿主态的唯一
// 权威是 `resolveHost()`，server 宿主要经 `GET /api/health` 握手才认得出来，本地 `isTauri()`
// 答不了。此前这里有第二处探测（`createDesktopToolNameCacheStorage()` 自己 `isTauri()`），
// 后果不是报错而是静默走岔：server 宿主下服务配置进了 `~/.webAgent/config.json`，
// 工具名缓存却落在浏览器 localStorage，两份状态分家。

export interface McpToolNameCacheStorage {
  readonly persistence: McpPersistenceMode
  load(): Promise<McpToolNameCache>
  save(cache: McpToolNameCache): Promise<void>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 浏览器通道用的 localStorage 键（测试要能指名道姓地放/查这份存量，所以导出）。 */
export const MCP_TOOL_NAME_CACHE_STORAGE_KEY = 'web-agent.mcp-tool-name-cache.v1'

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
  // parsed 已被 isPlainRecord 收窄成 Record<string, unknown>，而 sanitizeToolNameCache
  // 本来就接受 unknown——直接取 .cache 即可，不需要断言成 envelope（那个断言过不了
  // TS 的重叠检查，因为 version 是字面量类型）。
  if (isPlainRecord(parsed) && parsed.version === 1) {
    return sanitizeToolNameCache(parsed.cache)
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
// tauriMcpConfigStorage.ts / serverMcpConfigStorage.ts write `servers` into
// (see mcp_config.rs: the section is a plain object, each concern gets its own
// top-level key).
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
 * 配置文件通道的那一次调用。**两个宿主只差它**：桌面走 Tauri 原生 `invoke`，server 走
 * `POST /api/invoke/:command`。命令名、参数名（`patch`）、返回形状三者完全相同——host-node 的
 * `config/mcpConfigCommands.ts` 是 `apps/desktop/src/mcp_config.rs` 的等价移植。
 *
 * 【为什么抽成参数而不是像 serverMcpConfigStorage.ts 那样另写一份】那边两份实现之间还隔着
 * 一次性迁移、servers 三态判定这些真有分量的段语义，复制一遍换来的是各自独立可读；这里
 * 除了这一次调用之外只剩"取键 → 清洗"和两句错误文案，复制一遍等于给同一条规则立第二个权威。
 */
type McpConfigCommandInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

/**
 * 读写落在 `~/.webAgent/config.json` 的 `mcp.toolNameCache` 键下。写入是 `mcp_config_write`
 * 的合并语义，只替换这个键，不影响同一段里的 servers 等其它键。
 */
function createConfigFileToolNameCacheStorage(
  invokeConfigCommand: McpConfigCommandInvoke,
): McpToolNameCacheStorage {
  return {
    persistence: 'persistent',
    async load() {
      let section: unknown
      try {
        section = await invokeConfigCommand('mcp_config_read')
      } catch (error) {
        throw describeError('无法读取 MCP 工具名缓存', error)
      }
      return sanitizeToolNameCache(extractToolNameCacheSection(section))
    },
    async save(cache) {
      const safeCache = sanitizeToolNameCache(cache)
      try {
        await invokeConfigCommand('mcp_config_write', {
          patch: { [MCP_CONFIG_TOOL_NAME_CACHE_KEY]: safeCache },
        })
      } catch (error) {
        throw describeError('无法保存 MCP 工具名缓存', error)
      }
    },
  }
}

/**
 * 桌面端：走 A3 打通的 mcp_config_read / mcp_config_write 两个 Tauri command
 * （apps/desktop/src/mcp_config.rs）。
 *
 * 假定 Tauri 宿主确实在（装配层已经用 `resolveHost()` 判过），本函数不再自己探一次。
 */
export function createTauriToolNameCacheStorage(): McpToolNameCacheStorage {
  // 无参命令保持单实参的调用形状，与 tauriMcpConfigStorage.ts 逐字一致。
  return createConfigFileToolNameCacheStorage((command, args) =>
    args === undefined ? invoke(command) : invoke(command, args))
}

/**
 * server 宿主：同一对命令名，但经 `POST /api/invoke/mcp_config_{read,write}` 打到本机 Node
 * 后端（host-node 的 config 域），落的是**同一份** `~/.webAgent/config.json`。
 *
 * 假定 server 宿主确实在（装配层已经用 `resolveHost()` 判过），本函数不再自己探一次。
 */
export function createServerToolNameCacheStorage(): McpToolNameCacheStorage {
  // 无参命令显式传 `undefined`：`args` 在 invokeServerCommand 上是必填形参，与
  // serverMcpConfigStorage.ts 的同款记档一致。
  return createConfigFileToolNameCacheStorage((command, args) =>
    invokeServerCommand<unknown>(command, args))
}

/**
 * 按装配点解析出来的宿主态选一条通道 —— **与服务配置必须落到同一处**（C7）。
 *
 * 三态各走各的，与 `initialize.ts` 里服务配置那一半逐条对应：
 *   · `tauri`  —— Tauri 命令通道 → `~/.webAgent/config.json`
 *   · `server` —— HTTP 命令通道 → 同一份 `~/.webAgent/config.json`
 *   · `static` —— localStorage（没有任何本机能力，缓存只能留在浏览器里）
 */
export function createToolNameCacheStorageForHost(host: ResolvedHost): McpToolNameCacheStorage {
  switch (host.kind) {
    case 'tauri':
      return createTauriToolNameCacheStorage()
    case 'server':
      return createServerToolNameCacheStorage()
    case 'static':
      return createBrowserToolNameCacheStorage()
  }
}
