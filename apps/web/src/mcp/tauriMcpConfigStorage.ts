import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  createBrowserMcpConfigStorage,
  sanitizeConfigs,
  type McpConfigStorage,
} from './persistence'

// Top-level key inside the desktop config file's `mcp` section that holds
// the persisted server list. Kept distinct from whatever key the tool-list
// cache (B1/B2) ends up using inside the same section.
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

function extractServers(section: unknown): readonly unknown[] {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return []
  }
  const servers = (section as Record<string, unknown>)[MCP_CONFIG_SERVERS_KEY]
  if (servers === undefined) return []
  if (!Array.isArray(servers)) {
    throw new Error('mcp 配置段中的 servers 字段格式无效')
  }
  return servers
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
  return {
    persistence: 'persistent',
    async load() {
      let section: unknown
      try {
        section = await invoke('mcp_config_read')
      } catch (error) {
        throw describeError('无法读取 MCP 配置', error)
      }
      return sanitizeConfigs(extractServers(section))
    },
    async save(configs) {
      const safeConfigs = sanitizeConfigs(configs)
      try {
        await invoke('mcp_config_write', {
          patch: { [MCP_CONFIG_SERVERS_KEY]: safeConfigs },
        })
      } catch (error) {
        throw describeError('无法保存 MCP 配置', error)
      }
    },
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
