import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, McpServerSnapshot, McpToolSnapshot } from '@einfach-agent/tools-mcp'
import { createMcpConnectedCacheRefresher } from './refreshOnConnect'
import type { McpToolNameCache } from './toolNameCache'
import {
  createMemoryToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import { createMcpToolNameCacheHandle } from './toolNameCacheWriter'

/** 判据本身：哪些快照该落盘、哪些绝不能落盘，以及两个写入方共用一个写入点。 */

function serverConfig(id: string): McpServerConfig {
  return { id, name: id, transport: 'streamable-http', url: `https://${id}.example.com/mcp` }
}

function tool(serverId: string, remoteName: string, description?: string): McpToolSnapshot {
  return {
    name: `mcp__${serverId}__${remoteName}`,
    remoteName,
    description: description ?? `${remoteName} 工具`,
    inputSchema: { type: 'object' },
  }
}

function snapshot(
  id: string,
  status: McpServerSnapshot['status'],
  toolNames: readonly string[] = [],
): McpServerSnapshot {
  return {
    id,
    config: serverConfig(id),
    status,
    tools: toolNames.map((name) => tool(id, name)),
  }
}

/** save 慢到横跨好几个 tick，模拟宿主 IPC 往返打开的让出点；顺便数落盘次数。 */
function createCountingCacheStorage(initial: McpToolNameCache = {}): {
  storage: McpToolNameCacheStorage
  saved: McpToolNameCache[]
} {
  const inner = createMemoryToolNameCacheStorage(initial)
  const saved: McpToolNameCache[] = []
  return {
    saved,
    storage: {
      persistence: inner.persistence,
      load: inner.load,
      async save(next) {
        saved.push(next)
        for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
        await inner.save(next)
      },
    },
  }
}

function setup(initial: McpToolNameCache = {}) {
  const { storage, saved } = createCountingCacheStorage(initial)
  const removed = new Set<string>()
  const write = createMcpToolNameCacheHandle(storage).write
  const refresher = createMcpConnectedCacheRefresher({
    write,
    shouldRefresh: (id) => !removed.has(id),
  })
  return { storage, saved, write, refresher, removed }
}

const CACHED_DOCS: McpToolNameCache = {
  docs: {
    tools: [{ name: 'mcp__docs__search', description: '搜索文档' }],
    toolCount: 1,
    cachedAt: 1_700_000_000_000,
    probeStatus: 'success',
  },
}

describe('MCP 连接成功刷新工具名缓存', () => {
  it('连接成功时把真实工具清单写进缓存', async () => {
    const { storage, refresher } = setup()

    // 连接过程中的中间态不落盘：清单还不是真的。
    await refresher.observe([snapshot('team-search', 'connecting')])
    expect(await storage.load()).toEqual({})

    await refresher.observe([snapshot('team-search', 'connected', ['search', 'fetch'])])

    expect(await storage.load()).toEqual({
      'team-search': {
        tools: [
          { name: 'mcp__team-search__search', description: 'search 工具' },
          { name: 'mcp__team-search__fetch', description: 'fetch 工具' },
        ],
        toolCount: 2,
        cachedAt: expect.any(Number),
        probeStatus: 'success',
      },
    })
  })

  it('断开、连接失败、退避重连都保留缓存', async () => {
    const { storage, saved, refresher } = setup()
    await refresher.observe([snapshot('docs', 'connected', ['search'])])
    const cached = await storage.load()

    for (const status of ['disconnected', 'reconnecting', 'error', 'connecting'] as const) {
      await refresher.observe([snapshot('docs', status)])
    }

    // 未连接时模型只能靠这份「上次已知」判断要不要连，清空它等于让按需连接失明。
    expect(await storage.load()).toEqual(cached)
    expect(saved).toHaveLength(1)
  })

  it('「只登记未连接」的记录不会用空清单覆盖已有缓存', async () => {
    // F6 之后冷启动会把【全部】已配置服务登记进 manager，于是快照流里常年躺着
    // status 'disconnected' + 空工具表的记录。它说的是「现在没连着」，不是「没有工具」。
    const { storage, saved, refresher } = setup(CACHED_DOCS)

    await refresher.observe([snapshot('docs', 'disconnected')])

    expect(await storage.load()).toEqual(CACHED_DOCS)
    expect(saved).toEqual([])
  })

  it('tools/list_changed 对账后的再次 emit 会刷新缓存', async () => {
    const { storage, saved, refresher } = setup()
    await refresher.observe([snapshot('docs', 'connected', ['search'])])

    // manager 收到 tools/list_changed 会重新对账并再 emit 一份 connected 快照。
    await refresher.observe([snapshot('docs', 'connected', ['search', 'draft'])])

    expect(saved).toHaveLength(2)
    expect((await storage.load()).docs).toEqual(expect.objectContaining({
      toolCount: 2,
      tools: [
        { name: 'mcp__docs__search', description: 'search 工具' },
        { name: 'mcp__docs__draft', description: 'draft 工具' },
      ],
    }))
  })

  it('高频快照不产生高频写盘：同一份连接快照重放多少次都只落一次', async () => {
    const { saved, refresher } = setup()
    const batch = [
      snapshot('docs', 'connected', ['search']),
      snapshot('local', 'disconnected'),
    ]

    await refresher.observe(batch)
    // 别的服务变一次状态，manager 就把全量快照数组重放一遍——串行地、并发地各来一轮。
    for (let round = 0; round < 10; round += 1) await refresher.observe(batch)
    await Promise.all(Array.from({ length: 10 }, () => refresher.observe(batch)))

    expect(saved).toHaveLength(1)
  })

  it('重新连上同一个服务会再落一次盘，把 cachedAt 刷到这一刻', async () => {
    const { storage, saved, refresher } = setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      await refresher.observe([snapshot('docs', 'connected', ['search'])])
      now.mockReturnValue(9_000)
      await refresher.observe([snapshot('docs', 'disconnected')])
      // 工具清单一模一样，但这是一次新的连接成功，「上次已知」的时刻要往前走。
      await refresher.observe([snapshot('docs', 'connected', ['search'])])
    } finally {
      now.mockRestore()
    }

    expect(saved).toHaveLength(2)
    expect((await storage.load()).docs?.cachedAt).toBe(9_000)
  })

  it('服务已经不在配置里就不再刷新它的缓存', async () => {
    const { saved, refresher, removed } = setup(CACHED_DOCS)
    removed.add('docs')

    await refresher.observe([snapshot('docs', 'connected', ['search'])])

    expect(saved).toEqual([])
  })

  it('并发写入不丢缓存条目：多个服务同时连上，以及与安装探测交错', async () => {
    // 缓存是整份对象，一次写入是读-改-写：读到旧快照再写回就会盖掉别人刚写的那条。
    // 这也是安装探测（B2）与连接成功刷新（B3）必须共用同一个 writer 的原因——
    // 各造一份 writer 就是两条队列各读各的旧快照。
    const { storage, write, refresher } = setup()

    await Promise.all([
      refresher.observe([
        snapshot('a', 'connected', ['x']),
        snapshot('b', 'connected', ['y']),
      ]),
      write('probed', { tools: [{ name: 'mcp__probed__ping' }], probeStatus: 'success' }),
    ])

    expect(Object.keys(await storage.load()).sort()).toEqual(['a', 'b', 'probed'])
  })
})
