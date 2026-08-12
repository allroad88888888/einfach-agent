import { sanitizePersistedMcpConfig } from './config'
import { stripMcpCredentialFields } from './credentialFields'
import type {
  McpPersistenceMode,
  PersistedMcpServerConfig,
} from './types'

export const MCP_SETTINGS_STORAGE_KEY = 'web-agent.mcp-servers.v1'
export const MCP_SETTINGS_MAX_SERVERS = 50

// Tauri-backed storage (see tauriMcpConfigStorage.ts) reaches the config
// file through an async IPC command, so both methods return promises even
// though the localStorage/memory implementations below resolve synchronously
// under the hood. Callers in service.ts already run inside async functions,
// so awaiting a same-tick promise changes no observable behavior for them.
export interface McpConfigStorage {
  readonly persistence: McpPersistenceMode
  load(): Promise<readonly PersistedMcpServerConfig[]>
  save(configs: readonly PersistedMcpServerConfig[]): Promise<void>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedEnvelope {
  version: 1
  servers: readonly PersistedMcpServerConfig[]
}

function serializeEnvelope(configs: readonly PersistedMcpServerConfig[]): string {
  const envelope: PersistedEnvelope = { version: 1, servers: configs }
  return JSON.stringify(envelope)
}

// Exported so the Tauri-backed storage (tauriMcpConfigStorage.ts) can apply
// the exact same whitelist/limit/dedupe rules to configs read from the
// desktop config file, instead of re-implementing them.
export function sanitizeConfigs(
  configs: readonly unknown[],
): readonly PersistedMcpServerConfig[] {
  if (configs.length > MCP_SETTINGS_MAX_SERVERS) {
    throw new Error(`MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`)
  }
  const sanitized = configs
    .map(sanitizePersistedMcpConfig)
    .filter((config): config is PersistedMcpServerConfig => config !== undefined)
  const ids = new Set<string>()
  for (const config of sanitized) {
    if (ids.has(config.id)) {
      throw new Error(`MCP 服务 ID 重复：${config.id}`)
    }
    ids.add(config.id)
  }
  return sanitized
}

/**
 * Parses one raw localStorage payload into sanitized configs. Exported so the
 * one-time migration into the desktop config file (legacyServerMigration.ts)
 * reads the legacy payload through the module that owns this storage format,
 * instead of re-deriving the envelope shape somewhere else.
 *
 * Throws on a malformed payload — callers decide whether that is a hard error
 * (localStorage host) or simply "no legacy data" (migration).
 */
export function parsePersistedMcpServers(raw: string): readonly PersistedMcpServerConfig[] {
  const parsed: unknown = JSON.parse(raw)
  const candidates = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1
      ? (parsed as { servers?: unknown }).servers
      : undefined
  if (!Array.isArray(candidates)) throw new Error('MCP 设置存储格式无效')
  return sanitizeConfigs(candidates)
}

/**
 * 浏览器存储专属的最后一道：剥掉 headers / env（C1）。
 *
 * 白名单（sanitizePersistedMcpConfig）现在**接受**这两个字段——桌面配置文件要靠它净化用户
 * 手写的凭据——所以「不落凭据」这条规则必须由宿主自己执行，而不是靠白名单一刀切。凭据的唯一
 * 落点是 `~/.webAgent/config.json`；localStorage 里的东西同源脚本和任何能读到这台机器
 * profile 的人都拿得到。
 */
function withoutCredentials(
  configs: readonly PersistedMcpServerConfig[],
): readonly PersistedMcpServerConfig[] {
  return configs.map(stripMcpCredentialFields)
}

export function createMcpConfigStorage(storage: StorageLike): McpConfigStorage {
  return {
    persistence: 'persistent',
    // async only to satisfy McpConfigStorage; the localStorage read itself
    // is still fully synchronous.
    async load() {
      const raw = storage.getItem(MCP_SETTINGS_STORAGE_KEY)
      if (!raw) return []
      // 先剥再回写：读后回写这条既有行为顺带把存量里的凭据字段清干净——不管它是历史遗留、
      // 手改的，还是别的宿主写进来的，读过一次就不再留在浏览器存储里。
      const configs = withoutCredentials(parsePersistedMcpServers(raw))
      // Rewrite the sanitized whitelist on read so known unsafe fields and
      // credential-shaped connection strings do not remain in localStorage.
      try {
        storage.setItem(MCP_SETTINGS_STORAGE_KEY, serializeEnvelope(configs))
      } catch {
        // Reading valid settings must still work in a read-only storage host.
      }
      return configs
    },
    async save(configs) {
      const safeConfigs = withoutCredentials(sanitizeConfigs(configs))
      storage.setItem(MCP_SETTINGS_STORAGE_KEY, serializeEnvelope(safeConfigs))
    },
  }
}

export function createMemoryMcpConfigStorage(
  initial: readonly PersistedMcpServerConfig[] = [],
): McpConfigStorage {
  let configs = sanitizeConfigs(initial)
  return {
    persistence: 'temporary',
    load: async () => configs.map((config) => ({ ...config })),
    async save(next) {
      configs = sanitizeConfigs(next)
    },
  }
}

export function createBrowserMcpConfigStorage(): McpConfigStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return createMcpConfigStorage(window.localStorage)
    }
  } catch {
    // Sandboxed browsers may expose localStorage but throw while accessing it.
  }
  return createMemoryMcpConfigStorage()
}
