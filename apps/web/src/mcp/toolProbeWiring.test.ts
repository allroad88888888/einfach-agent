// B5 的判据里最重的一条：B4 与 F4 那两根线【真的接上了】。
//
// 两根线各自的实现有各自的单测（cachedToolProviderProbe.test.ts、tools/mcp 的
// connect-mcp-server.lastKnown.test.ts），所以本文件不重复它们的内部行为，只钉装配：
// 缓存里的东西有没有沿着 registry 与运行时配置这两条路，真的走到模型面前。

import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { UnconnectedToolProviderProbe } from '@web-agent/core/tools/schemaResult'
import { describe, expect, it, vi } from 'vitest'
import {
  MCP_CONNECT_TOOL_NAME,
  createMcpPlaceholderClaims,
  makeMcpToolName,
  type McpClientManager,
  type McpConnectManager,
  type McpServerSnapshot,
  type McpServerStatus,
} from '@web-agent/tools-mcp'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import { wireMcpToolProbes } from './toolProbeWiring'

const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)

// 缓存里存的是【注册名】（写入见 toolNameCacheWriter 的 toCachedTools），B4 反查与 F4 清单
// 看到的都是它；fixture 写远端原名就会把两根线都测成假绿。
function cacheWithDocs(): McpToolNameCache {
  return setToolNameCacheEntry({}, 'docs', {
    tools: [
      { name: makeMcpToolName('docs', 'search'), description: '搜索文档' },
      { name: makeMcpToolName('docs', 'draft'), description: '起草文档' },
    ],
    probeStatus: 'success',
    cachedAt: CACHED_AT,
  })
}

function serverSnapshot(id: string, status: McpServerStatus): McpServerSnapshot {
  return {
    id,
    config: { id, transport: 'streamable-http', url: `https://${id}.example.test/mcp` },
    status,
    tools: [],
  }
}

/** 活的登记表：测试里改 status 就等于服务真的连上/断开了（并像真 manager 那样广播）。 */
function fakeManager(...servers: McpServerSnapshot[]) {
  const records = new Map(servers.map((server) => [server.id, server]))
  const listeners = new Set<(snapshots: readonly McpServerSnapshot[]) => void>()
  const manager = {
    reconnect: async () => {
      throw new Error('本测试不该连接任何服务')
    },
    get: (id: string) => records.get(id),
    list: () => [...records.values()],
    subscribe: (listener: (snapshots: readonly McpServerSnapshot[]) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as McpConnectManager & Pick<McpClientManager, 'list' | 'subscribe'>
  return {
    manager,
    setStatus(id: string, status: McpServerStatus) {
      const current = records.get(id)
      if (!current) throw new Error(`unknown server: ${id}`)
      records.set(id, { ...current, status })
      for (const listener of [...listeners]) listener([...records.values()])
    },
  }
}

function wire(options: {
  cache?: () => McpToolNameCache
  servers?: McpServerSnapshot[]
} = {}) {
  const registry = createToolRegistry()
  const { manager, setStatus } = fakeManager(
    ...(options.servers ?? [serverSnapshot('docs', 'disconnected')]),
  )
  let probe: UnconnectedToolProviderProbe | undefined
  const configure = vi.fn((config: { unconnectedToolProvider: UnconnectedToolProviderProbe }) => {
    probe = config.unconnectedToolProvider
  })
  let cache = options.cache?.() ?? cacheWithDocs()
  const claims = createMcpPlaceholderClaims()
  const wiring = wireMcpToolProbes({
    registry,
    manager,
    claims,
    getCache: () => cache,
    // 真实接法里这就是 manager 的登记表，所以这里也照着登记表答。
    isConnected: (serverId) => manager.get(serverId)?.status === 'connected',
    configure,
  })
  return {
    registry,
    configure,
    claims,
    setStatus,
    syncPlaceholders: wiring.syncPlaceholders,
    placeholderNames: () => registry.list()
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('mcp__'))
      .sort(),
    setCache: (next: McpToolNameCache) => {
      cache = next
    },
    /** 已接线的探针；没接上就是 undefined，测试会立刻炸在这里。 */
    probe: (toolName: string) => probe?.(toolName),
    connectToolDescription: () =>
      registry.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)?.description ?? '',
  }
}

describe('wireMcpToolProbes · B4 未连接工具探针', () => {
  it('缓存里的工具名被点名时，回的是「它出自哪个未连接服务」而不是 unknown tool', () => {
    const wired = wire()

    expect(wired.configure).toHaveBeenCalledTimes(1)
    expect(wired.probe(makeMcpToolName('docs', 'search')))
      .toEqual({ serverId: 'docs', cachedAt: CACHED_AT })
  })

  it('服务连上之后同一个工具名探针闭嘴——真实清单说了算（B4 的硬约束）', () => {
    const wired = wire()
    expect(wired.probe('mcp__docs__search')).toBeDefined()

    wired.setStatus('docs', 'connected')

    // 缓存一个字没变，只是服务连上了：再答「请先连接」就会把模型推进死循环。
    expect(wired.probe('mcp__docs__search')).toBeUndefined()
  })

  it('缓存里没有的名字不编造提供方', () => {
    const wired = wire()

    expect(wired.probe('mcp__docs__delete_everything')).toBeUndefined()
    expect(wired.probe('write_file')).toBeUndefined()
  })

  it('接的是缓存的读出口而不是接线那一刻的快照：之后写进缓存的工具立刻能被认出来', () => {
    const wired = wire({ cache: () => ({}) })
    expect(wired.probe('mcp__docs__search')).toBeUndefined()

    wired.setCache(cacheWithDocs())

    expect(wired.probe('mcp__docs__search')).toEqual({ serverId: 'docs', cachedAt: CACHED_AT })
  })
})

describe('wireMcpToolProbes · F4 连接工具的清单', () => {
  it('未连接服务的工具名进 connect_mcp_server 的描述，模型才知道该连哪个', () => {
    const wired = wire()

    const description = wired.connectToolDescription()
    expect(description).toContain('search')
    expect(description).toContain('draft')
    expect(description).toContain('docs')
    // 是历史不是当前事实，这层限定不能在接线里丢掉。
    expect(description).toContain('上次已知')
  })

  it('服务连上之后描述里不再重复它的历史清单——真实工具已经在工具表里了', () => {
    const wired = wire()
    expect(wired.connectToolDescription()).toContain('search')

    wired.setStatus('docs', 'connected')

    expect(wired.connectToolDescription()).not.toContain('search')
  })

  it('清单在调用当刻才取：探测写进缓存后无需重新注册就出现在描述里', () => {
    const wired = wire({ cache: () => ({}) })
    expect(wired.connectToolDescription()).not.toContain('上次已知')

    wired.setCache(cacheWithDocs())

    expect(wired.connectToolDescription()).toContain('search')
  })
})

describe('wireMcpToolProbes · D2 占位工具', () => {
  it('未连接服务的缓存清单以占位工具的形式进 registry，模型直接看得见', () => {
    const wired = wire()

    expect(wired.placeholderNames())
      .toEqual([makeMcpToolName('docs', 'draft'), makeMcpToolName('docs', 'search')])
    // 占位与登记表成对：账实相符是 reconcile 能放行同名占位的前提。
    expect(wired.claims.namesFor('docs').sort()).toEqual(wired.placeholderNames())
  })

  it('manager 状态变化经订阅自动重算：连上之后占位集合为空', () => {
    const wired = wire()
    expect(wired.placeholderNames()).toHaveLength(2)

    wired.setStatus('docs', 'connected')

    expect(wired.placeholderNames()).toEqual([])
  })

  it('缓存变化经宿主回调重算：syncPlaceholders 是接线交回给宿主的那个口子', () => {
    const wired = wire({ cache: () => ({}) })
    expect(wired.placeholderNames()).toEqual([])

    // 真实接法里这一步由缓存投影的 publish 触发（写入 / 删除 / 冷启动读盘各一次）。
    wired.setCache(cacheWithDocs())
    wired.syncPlaceholders()

    expect(wired.placeholderNames()).toHaveLength(2)
  })

  it('占位不覆盖真实工具：同名已注册时跳过', () => {
    const wired = wire()
    const name = makeMcpToolName('docs', 'search')
    const placeholder = wired.claims.get(name)?.tool

    // 模拟 reconcile 之后的状态：真实工具接管这个名字，占位登记已释放。
    wired.registry.register({
      name,
      runtime: 'internal',
      skill: { description: '真实工具', content: '真实指南' },
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true }),
    })
    wired.claims.release(name, placeholder)

    wired.syncPlaceholders()

    expect(wired.registry.list().find((entry) => entry.name === name)?.description)
      .toBe('真实工具')
    expect(wired.claims.get(name)).toBeUndefined()
  })
})
