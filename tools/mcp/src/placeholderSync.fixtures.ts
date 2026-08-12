// 占位同步器两组用例共用的替身：活的登记表、缓存清单、以及把它们接起来的 setup。
// 沿用 clientManager.reconnect.fixtures.ts 的做法——替身独立成文件，测试文件只留判据。

import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { Tool } from '@web-agent/core/tools/types'
import { vi } from 'vitest'
import type { McpLastKnownToolList } from './connect-mcp-server/lastKnownTools'
import { createMcpPlaceholderClaims } from './placeholderClaims'
import { createMcpPlaceholderSync, type McpPlaceholderSkip } from './placeholderSync'
import type {
  McpClientManagerListener,
  McpServerSnapshot,
  McpServerStatus,
} from './types'

export const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)

export function snapshot(id: string, status: McpServerStatus): McpServerSnapshot {
  return {
    id,
    config: { id, transport: 'streamable-http', url: `https://${id}.example.test/mcp` },
    status,
    tools: [],
  }
}

export function stdioSnapshot(id: string, status: McpServerStatus): McpServerSnapshot {
  return { id, config: { id, transport: 'stdio', command: 'node' }, status, tools: [] }
}

/** 活的登记表替身：改 status / 增删记录都会像真 manager 那样广播一次。 */
export function fakeManager(...servers: McpServerSnapshot[]) {
  const records = new Map(servers.map((server) => [server.id, server]))
  const listeners = new Set<McpClientManagerListener>()
  const emit = (): void => {
    const current = [...records.values()]
    for (const listener of [...listeners]) listener(current)
  }
  return {
    manager: {
      list: () => [...records.values()],
      subscribe: (listener: McpClientManagerListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      // 同步器自己一次都不调这两个，它们是原样转交给透明连接执行器的（D3b）。
      // 生命周期的用例不该连接任何东西，所以 reconnect 直接炸——真连上了就是判据错了。
      get: (id: string) => records.get(id),
      reconnect: async (): Promise<McpServerSnapshot> => {
        throw new Error('本测试不该连接任何服务')
      },
    },
    setStatus(id: string, status: McpServerStatus) {
      const current = records.get(id)
      if (!current) throw new Error(`unknown server: ${id}`)
      records.set(id, { ...current, status })
      emit()
    },
    remove(id: string) {
      records.delete(id)
      emit()
    },
    add(server: McpServerSnapshot) {
      records.set(server.id, server)
      emit()
    },
  }
}

export function lastKnown(
  serverId: string,
  names: readonly string[],
  overrides: Partial<McpLastKnownToolList> = {},
): McpLastKnownToolList {
  return {
    serverId,
    tools: names.map((name) => ({ name, description: `${name} 的说明` })),
    toolCount: names.length,
    truncated: false,
    cachedAt: CACHED_AT,
    probeStatus: 'success',
    ...overrides,
  }
}

export interface PlaceholderSyncSetupOptions {
  servers?: McpServerSnapshot[]
  cache?: Record<string, McpLastKnownToolList>
  onSkip?(skip: McpPlaceholderSkip): void
}

export function setupPlaceholderSync(options: PlaceholderSyncSetupOptions = {}) {
  const registry = createToolRegistry()
  const claims = createMcpPlaceholderClaims()
  const fake = fakeManager(...(options.servers ?? [snapshot('docs', 'disconnected')]))
  let cache: Record<string, McpLastKnownToolList> =
    options.cache ?? { docs: lastKnown('docs', ['mcp__docs__search', 'mcp__docs__draft']) }
  const probe = vi.fn((serverId: string) => cache[serverId])

  const sync = createMcpPlaceholderSync({
    registry,
    manager: fake.manager,
    claims,
    lastKnownTools: probe,
    ...(options.onSkip ? { onSkip: options.onSkip } : {}),
  })

  return {
    registry,
    claims,
    sync,
    probe,
    ...fake,
    setCache(next: Record<string, McpLastKnownToolList>) {
      cache = next
    },
    names: () => registry.list().map((entry) => entry.name).sort(),
    description: (name: string) =>
      registry.list().find((entry) => entry.name === name)?.description,
    runtime: (name: string) => registry.list().find((entry) => entry.name === name)?.runtime,
  }
}

/** 与占位形状无关的替身：纪律用例只关心「谁占着这个名字」。 */
export function fakeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: 'stand-in', content: 'stand-in guide' },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}
