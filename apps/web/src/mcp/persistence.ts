import { sanitizePersistedMcpConfig } from './config'
import type {
  McpPersistenceMode,
  PersistedMcpServerConfig,
} from './types'

export const MCP_SETTINGS_STORAGE_KEY = 'web-agent.mcp-servers.v1'
export const MCP_SETTINGS_MAX_SERVERS = 50

export interface McpConfigStorage {
  readonly persistence: McpPersistenceMode
  load(): readonly PersistedMcpServerConfig[]
  save(configs: readonly PersistedMcpServerConfig[]): void
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

function sanitizeConfigs(
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

function parseEnvelope(raw: string): readonly PersistedMcpServerConfig[] {
  const parsed: unknown = JSON.parse(raw)
  const candidates = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1
      ? (parsed as { servers?: unknown }).servers
      : undefined
  if (!Array.isArray(candidates)) throw new Error('MCP 设置存储格式无效')
  return sanitizeConfigs(candidates)
}

export function createMcpConfigStorage(storage: StorageLike): McpConfigStorage {
  return {
    persistence: 'persistent',
    load() {
      const raw = storage.getItem(MCP_SETTINGS_STORAGE_KEY)
      if (!raw) return []
      const configs = parseEnvelope(raw)
      // Rewrite the sanitized whitelist on read so known unsafe fields and
      // credential-shaped connection strings do not remain in localStorage.
      try {
        storage.setItem(MCP_SETTINGS_STORAGE_KEY, serializeEnvelope(configs))
      } catch {
        // Reading valid settings must still work in a read-only storage host.
      }
      return configs
    },
    save(configs) {
      const safeConfigs = sanitizeConfigs(configs)
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
    load: () => configs.map((config) => ({ ...config })),
    save(next) {
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
