import { invoke, isTauri } from '@tauri-apps/api/core'
import { createLegacyMcpServerMigration } from './legacyServerMigration'
import {
  createBrowserMcpConfigStorage,
  sanitizeConfigs,
  type McpConfigStorage,
} from './persistence'
import type { PersistedMcpServerConfig } from './types'

// Top-level key inside the desktop config file's `mcp` section that holds
// the persisted server list. Kept distinct from the tool-name cache's own key
// in the same section (see toolNameCacheStorage.ts).
const MCP_CONFIG_SERVERS_KEY = 'servers'

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
 * 取出 mcp 段里的 servers 列表，并把三种情况分开：
 *
 * - `undefined`：这个键根本不存在（含整段缺失/形状不对）——配置文件这边还没有任何服务
 *   配置，是 B2 迁移唯一的触发条件。
 * - 数组：以配置文件为准，哪怕是空数组（用户可能刚把最后一个服务删掉，此时把
 *   localStorage 里的旧清单搬回去等于撤销这次删除）。
 * - 抛错：键存在但格式非法——报出来，绝不用迁移覆盖它，那等于悄悄替用户改配置文件。
 */
function extractServers(section: unknown): readonly unknown[] | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return undefined
  }
  const servers = (section as Record<string, unknown>)[MCP_CONFIG_SERVERS_KEY]
  if (servers === undefined) return undefined
  if (!Array.isArray(servers)) {
    throw new Error('mcp 配置段中的 servers 字段格式无效')
  }
  return servers
}

async function writeServers(configs: readonly PersistedMcpServerConfig[]): Promise<void> {
  const safeConfigs = sanitizeConfigs(configs)
  try {
    await invoke('mcp_config_write', {
      patch: { [MCP_CONFIG_SERVERS_KEY]: safeConfigs },
    })
  } catch (error) {
    throw describeError('无法保存 MCP 配置', error)
  }
}

/**
 * Reads/writes the MCP server list through the desktop `mcp_config_read` /
 * `mcp_config_write` Tauri commands (see apps/desktop/src/mcp_config.rs),
 * which persist into the `mcp.servers` key of `~/.webAgent/config.json`.
 *
 * Assumes a Tauri host is actually present — use createDesktopMcpConfigStorage
 * below to get the non-Tauri fallback for free.
 */
export function createTauriMcpConfigStorage(): McpConfigStorage {
  // 迁移复用同一条写通道（净化、错误话术都只有一处），一次性的判定与去重在
  // legacyServerMigration.ts 里，这里只负责说清楚「什么时候轮到它」。
  const migrateLegacyServers = createLegacyMcpServerMigration(writeServers)
  return {
    persistence: 'persistent',
    async load() {
      let section: unknown
      try {
        section = await invoke('mcp_config_read')
      } catch (error) {
        throw describeError('无法读取 MCP 配置', error)
      }
      const servers = extractServers(section)
      // 配置文件里还没有 servers 键 → 这是把 localStorage 存量搬进来的唯一时机（B2）。
      // 没有存量时它同样返回空数组，行为与迁移之前一致。
      if (servers === undefined) return migrateLegacyServers()
      return sanitizeConfigs(servers)
    },
    save: writeServers,
  }
}

/**
 * Desktop-preferred storage: uses the Tauri config-file channel when a
 * Tauri host is present, and transparently falls back to the existing
 * localStorage/memory implementation everywhere else (browser, tests).
 */
export function createDesktopMcpConfigStorage(): McpConfigStorage {
  if (!isTauri()) return createBrowserMcpConfigStorage()
  return createTauriMcpConfigStorage()
}
