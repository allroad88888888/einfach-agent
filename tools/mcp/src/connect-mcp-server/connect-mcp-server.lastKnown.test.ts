// connect_mcp_server 的「上次已知工具清单」契约（F4）。
//
// 锁的是按需连接模式的承重逻辑：未连接服务的工具不在工具清单里，模型必须能从【本工具的 manifest
// 描述】里看出"我要的能力在哪个服务上"，否则它压根不会去连，直接回一句"我没有这个能力"。
// 因此这里逐条钉死：清单出现在哪一层、cachedAt 有没有被呈现、超限怎么截、探针没接线时会不会编造。
import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { describe, expect, it } from 'vitest'
import { registerMcpTools } from '../index'
import {
  CACHED_AT_DATE,
  CACHED_AT_TIMESTAMP,
  fakeManager,
  lastKnownList,
  serverSnapshot,
  toolSnapshot,
} from './connect-mcp-server.fixtures'
import {
  MCP_CONNECT_GUIDE_MAX_CHARS,
  MCP_CONNECT_MANIFEST_MAX_CHARS,
  MCP_CONNECT_MANIFEST_MAX_SERVERS,
  MCP_CONNECT_TOOL_NAME,
  createMcpConnectTool,
  type McpConnectManager,
  type McpLastKnownToolList,
} from './connect-mcp-server'

/** 同一个 manager 上"没接探针"的那份 skill —— 一切增量都相对它来量。 */
function baselineSkill(manager: McpConnectManager) {
  return createMcpConnectTool(manager).skill
}

describe('connect_mcp_server · 未连接服务的上次已知清单 · manifest 层', () => {
  it('把未连接服务的工具名列进工具描述，并标注探测日期', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [lastKnownList('weather', ['forecast', 'alerts'])],
    }).skill

    expect(description).toContain(`weather（${CACHED_AT_DATE}，共 2 个）forecast、alerts`)
    // 三件事必须同时在场：是历史、时间基准明确、连上后以真实清单为准。
    expect(description).toContain('上次已知')
    expect(description).toContain('UTC 日期，可能已过期')
    expect(description).toContain('连上后一律以服务返回的真实清单为准')
    // 超出 manifest 的部分去哪儿取，也要写在 manifest 里，否则截断等于丢失。
    expect(description).toContain('request_tool_schema')
  })

  it('manifest 只放工具名，短描述留给 guide —— 名字是路由键，描述是细节', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description, content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', [{ name: 'forecast', description: '获取指定城市的天气预报' }]),
      ],
    }).skill

    expect(description).toContain('forecast')
    expect(description).not.toContain('获取指定城市的天气预报')
    expect(content).toContain('- forecast —— 获取指定城市的天气预报')
  })

  it('不重复列出已连接服务 —— 它的工具已经在工具清单里了', () => {
    const { manager } = fakeManager([
      serverSnapshot('weather', 'connected', [toolSnapshot('mcp__weather__forecast')]),
      serverSnapshot('github', 'disconnected'),
    ])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', ['forecast']),
        lastKnownList('github', ['create_issue']),
      ],
    }).skill

    expect(description).toContain('github（')
    expect(description).not.toContain('weather')
    expect(description).not.toContain('forecast')
  })

  it('缓存侧截断过的清单，用 toolCount 与省略号交代"这不是全部"', () => {
    const { manager } = fakeManager([serverSnapshot('bulk', 'disconnected')])

    const { description, content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('bulk', ['a', 'b', 'c'], { toolCount: 24, truncated: true }),
      ],
    }).skill

    expect(description).toContain(`bulk（${CACHED_AT_DATE}，共 24 个）a、b、c…`)
    expect(content).toContain('共 24 个工具 · 此处列出 3 个')
  })

  it('每次读描述都重新取缓存 —— 刚装的服务立刻可见，不用等重新注册', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    let cache: readonly McpLastKnownToolList[] = [lastKnownList('weather', ['forecast'])]
    const tool = createMcpConnectTool(manager, { lastKnownTools: () => cache })

    expect(tool.skill.description).toContain('forecast')

    cache = [lastKnownList('weather', ['radar'])]

    expect(tool.skill.description).toContain('radar')
    expect(tool.skill.description).not.toContain('forecast')
  })
})

describe('connect_mcp_server · 呈现侧上限', () => {
  const BULK_SERVER_COUNT = 40
  const bulkServers = Array.from({ length: BULK_SERVER_COUNT }, (_unused, index) =>
    serverSnapshot(`srv-${index}`, 'disconnected'))
  const bulkLists = bulkServers.map((server, serverIndex) =>
    lastKnownList(
      server.id,
      Array.from({ length: 30 }, (_unused, toolIndex) => `tool_${serverIndex}_${toolIndex}`),
    ))

  it('manifest 段落被钉在上限内，并说明有多少没展开', () => {
    const { manager } = fakeManager([...bulkServers])
    const base = baselineSkill(manager).description

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => bulkLists,
    }).skill

    expect(description.startsWith(base)).toBe(true)
    expect(description.length - base.length).toBeLessThanOrEqual(MCP_CONNECT_MANIFEST_MAX_CHARS)
    const dropped = description.match(/另有 (\d+) 个未连接服务的清单因长度上限未展开/)
    expect(dropped).not.toBeNull()
    expect(Number(dropped?.[1])).toBeGreaterThanOrEqual(
      BULK_SERVER_COUNT - MCP_CONNECT_MANIFEST_MAX_SERVERS,
    )
  })

  it('预算按服务摊薄，而不是被排在前面的服务一口吃光', () => {
    const { manager } = fakeManager([...bulkServers])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => bulkLists,
    }).skill

    // 每个被列出的服务都还在，且都至少露出一个工具名 —— 否则那些服务等于从上下文里消失了。
    const listedServers = [...description.matchAll(/srv-\d+（/g)].length
    expect(listedServers).toBe(MCP_CONNECT_MANIFEST_MAX_SERVERS)
    for (let index = 0; index < MCP_CONNECT_MANIFEST_MAX_SERVERS; index += 1) {
      expect(description).toContain(`tool_${index}_0`)
    }
    // 第一个服务没有把 30 个工具名全塞进去。
    expect([...description.matchAll(/tool_0_\d+/g)].length).toBeLessThan(30)
  })

  it('guide 段落也有自己的（更宽松的）上限，两级降级都留下痕迹', () => {
    const { manager } = fakeManager([...bulkServers])
    const base = baselineSkill(manager).content

    const { content } = createMcpConnectTool(manager, {
      lastKnownTools: () => bulkLists.map((list) =>
        lastKnownList(list.serverId, list.tools.map((tool) => ({
          name: tool.name,
          description: 'D'.repeat(300),
        })))),
    }).skill

    expect(content.startsWith(base)).toBe(true)
    expect(content.length - base.length).toBeLessThanOrEqual(MCP_CONNECT_GUIDE_MAX_CHARS)
    // 第一级：服务留着，工具行被削 —— 「共 N 个 · 此处列出 M 个」交代差额。
    expect(content).toMatch(/共 30 个工具 · 此处列出 \d+ 个/)
    // 第二级：削到每个服务只剩一行仍超预算 → 整条丢弃，但必须留下数量痕迹。
    expect(content).toMatch(/还有 \d+ 个未连接服务的清单因长度上限未列出/)
  })
})

describe('connect_mcp_server · 拿不到清单的服务', () => {
  it('说成「暂无已知清单」，绝不说成「没有工具」', () => {
    const { manager } = fakeManager([
      serverSnapshot('weather', 'disconnected'),
      serverSnapshot('db', 'error'),
      serverSnapshot('files', 'disconnected'),
      serverSnapshot('empty', 'disconnected'),
    ])

    const { description, content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', ['forecast']),
        lastKnownList('db', [], { probeStatus: 'failed' }),
        lastKnownList('empty', []),
      ],
    }).skill

    expect(description).toContain('另有 3 个未连接服务暂无已知清单（不等于没有工具，连上后才知道）')
    // 没有清单的服务不占 manifest 的清单预算，但在 guide 里要交代是谁、为什么。
    expect(description).not.toMatch(/db（\d{4}-/)
    expect(content).toContain('db（上次探测失败）')
    expect(content).toContain('files（尚未探测过）')
    expect(content).toContain('empty（上次探测到空清单）')
    expect(content).toContain('这些服务不是「没有工具」')
  })

  it('一个清单都拿不到时仍然发声，让那些服务不至于从上下文里消失', () => {
    const { manager } = fakeManager([
      serverSnapshot('db', 'disconnected'),
      serverSnapshot('files', 'disconnected'),
    ])

    const { description } = createMcpConnectTool(manager, { lastKnownTools: () => [] }).skill

    expect(description).toContain('有 2 个已配置但未连接的 MCP 服务暂无已知清单')
    expect(description).toContain('request_tool_schema')
  })
})

describe('connect_mcp_server · 探针未接线时的降级', () => {
  it('没接探针 → 描述与 guide 原样，一个字都不编', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description, content } = createMcpConnectTool(manager).skill

    expect(description).not.toContain('上次已知')
    expect(content).not.toContain('## 未连接服务的【上次已知】工具')
    expect(description).toContain('按需连接一个【已配置】的 MCP 服务')
    // 静态 guide 一个字不改：不接线时它不该声称"描述里列出了清单"。
    expect(content).toBe(createMcpConnectTool(manager, {}).skill.content)
  })

  it('探针本身抛错 → 退回原样，不能让一根坏掉的宿主接线打断整次模型请求', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    const tool = createMcpConnectTool(manager, {
      lastKnownTools: () => {
        throw new Error('cache read exploded')
      },
    })

    expect(() => tool.skill).not.toThrow()
    expect(tool.skill.description).toBe(baselineSkill(manager).description)
  })

  it('登记表读不出来 → 同样退回原样', () => {
    const manager: McpConnectManager = {
      get: () => undefined,
      list: () => {
        throw new Error('manager not ready')
      },
      reconnect: async () => serverSnapshot('weather', 'connected'),
    }

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [lastKnownList('weather', ['forecast'])],
    }).skill

    expect(description).not.toContain('forecast')
    expect(description).not.toContain('上次已知')
  })

  it('缓存里残留的、已经被删掉的服务不会复活', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', ['forecast']),
        lastKnownList('removed-long-ago', ['ghost_tool']),
      ],
    }).skill

    expect(description).toContain('forecast')
    expect(description).not.toContain('ghost_tool')
  })
})

describe('registerMcpTools · 上次已知清单的接线', () => {
  it('把探针一路带到 registry.list() 的 manifest 摘要与 loadSchema 的 guide 里', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    const registry = createToolRegistry()

    registerMcpTools(registry, {
      manager,
      lastKnownTools: () => [
        lastKnownList('weather', [{ name: 'forecast', description: '天气预报' }]),
      ],
    })

    const summary = registry.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)
    expect(summary?.description).toContain(`weather（${CACHED_AT_DATE}，共 1 个）forecast`)
    expect(summary?.description).not.toContain('天气预报')

    const loaded = registry.loadSchema(MCP_CONNECT_TOOL_NAME)
    expect(loaded?.guide).toContain(`上次已知 ${CACHED_AT_TIMESTAMP}`)
    expect(loaded?.guide).toContain('- forecast —— 天气预报')
    expect(loaded?.guide).toContain('**这是历史，不是当前事实**')
  })

  it('不传探针时注册照常成功，只是描述里没有清单', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    const registry = createToolRegistry()

    registerMcpTools(registry, { manager })

    const summary = registry.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)
    expect(summary?.description).not.toContain('上次已知')
  })
})
