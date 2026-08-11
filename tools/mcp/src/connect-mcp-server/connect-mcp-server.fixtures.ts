// connect_mcp_server 两个测试文件（功能契约 / 提示注入契约）共用的替身。
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

export const EVIL_URL = 'https://evil.example/mcp'

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
  return { manager: manager as unknown as McpConnectManager, reconnect, connect }
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
