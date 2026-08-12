// connect_mcp_server 三个测试文件（功能契约 / 提示注入契约 / 上次已知清单）共用的替身。
// 只在测试里被 import，不从域 barrel 导出。
import type { ToolContext } from '@web-agent/core/tools/types'
import { vi } from 'vitest'
import type {
  McpOperationOptions,
  McpServerSnapshot,
  McpServerStatus,
  McpToolSnapshot,
} from '../types'
import type { McpConnectManager } from './connect-mcp-server'
import type { McpLastKnownToolList } from './lastKnownTools'

export const EVIL_URL = 'https://evil.example/mcp'

/** 固定探测时刻，让「上次已知」文案里的 UTC 时间戳在测试里是常量。 */
export const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)
export const CACHED_AT_TIMESTAMP = '2026-08-10T09:30:00Z'

/** 造一条宿主探针会给出的「上次已知」清单。字符串工具名 = 无描述。 */
export function lastKnownList(
  serverId: string,
  tools: ReadonlyArray<string | { name: string; description: string }>,
  overrides: Partial<McpLastKnownToolList> = {},
): McpLastKnownToolList {
  const entries = tools.map((tool) =>
    typeof tool === 'string' ? { name: tool, description: '' } : tool)
  return {
    serverId,
    tools: entries,
    toolCount: entries.length,
    truncated: false,
    cachedAt: CACHED_AT,
    probeStatus: 'success',
    ...overrides,
  }
}

export function toolSnapshot(name: string, description = name): McpToolSnapshot {
  return {
    name,
    remoteName: name.replace(/^mcp__[^_]+__/, ''),
    description,
    inputSchema: { type: 'object' },
  }
}

export function serverSnapshot(
  id: string,
  status: McpServerStatus,
  tools: readonly McpToolSnapshot[] = [],
): McpServerSnapshot {
  return {
    id,
    config: {
      id,
      transport: 'streamable-http',
      url: 'https://mcp.example.test',
      headers: { authorization: 'Bearer SECRET_TOKEN' },
    },
    status,
    tools,
  }
}

export interface FakeMcpManager {
  manager: McpConnectManager
  reconnect: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  /**
   * 活的登记表。manager 的 get/list 都实时读它，所以测试里往这里增删服务，
   * 就等于用户在设置里增删了一个 MCP 服务 —— 用来验证 inputSchema 的 enum 是否真的跟着变。
   */
  records: Map<string, McpServerSnapshot>
}

/**
 * 假 manager 只实现工具用得到的三个方法，外加一个【绝不该被调用】的 connect：
 * 它存在的唯一目的，是在工具真的走了「拿配置去连」这条路时立刻炸出来。
 */
export function fakeManager(
  servers: McpServerSnapshot[],
  options?: {
    onReconnect?(serverId: string, operation?: McpOperationOptions): McpServerSnapshot
  },
): FakeMcpManager {
  const records = new Map(servers.map((server) => [server.id, server]))
  const reconnect = vi.fn(async (serverId: string, operation?: McpOperationOptions) => {
    const record = records.get(serverId)
    if (!record) throw new Error(`Unknown MCP server: ${serverId}`)
    const next = options?.onReconnect?.(serverId, operation)
      ?? { ...record, status: 'connected' as const }
    records.set(serverId, next)
    return next
  })
  const connect = vi.fn(() => {
    throw new Error('connect(config) must never be reachable from the model')
  })
  const manager = {
    reconnect,
    connect,
    get: (serverId: string) => records.get(serverId),
    list: () => [...records.values()],
  }
  return { manager: manager as unknown as McpConnectManager, reconnect, connect, records }
}

export function toolContext(signal = new AbortController().signal): ToolContext {
  return {
    sessionId: 'session-1',
    signal,
    progress: () => undefined,
    callTool: async () => ({ ok: true }),
    runShell: async () => {
      throw new Error('runShell is not used by connect_mcp_server')
    },
    renderCard: () => ({ cardId: 'card-1' }),
    saveArtifact: () => ({ artifactId: 'artifact-1' }),
  }
}
