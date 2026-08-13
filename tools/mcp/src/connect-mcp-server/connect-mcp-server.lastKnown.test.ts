// connect_mcp_server 的「上次已知工具清单」契约（F4），D4 文案去重之后的形态。
//
// 透明连接上线后（D2/D3b），有【上次已知】清单的未连接服务，其工具已经作为占位工具注册进
// ToolRegistry，本身就在模型每次都能看到的工具清单里。所以本文件不再锁"逐条工具名要出现在
// manifest/guide 里"——那条契约已经被占位机制接管，继续锁它就是在保护一个刻意删除的行为。
// 这里改锁：① manifest 只给一句状态摘要（未连接总数 + 无清单服务 ID + 一句提示），不点名任何
// 有清单的服务；② guide 补诊断细节（探测时间、工具数量、无清单原因），同样不列单条工具名；
// ③ 无清单的服务（没有占位）必须在两层都能被点名找到，否则它们对模型彻底不存在。
import { createToolRegistry } from '@web-agent/core/tools'
import { describe, expect, it } from 'vitest'
import { registerMcpTools } from '../index'
import {
  CACHED_AT_TIMESTAMP,
  fakeManager,
  lastKnownList,
  serverSnapshot,
  toolSnapshot,
} from './connect-mcp-server.fixtures'
import {
  MCP_CONNECT_GUIDE_MAX_CHARS,
  MCP_CONNECT_GUIDE_MAX_SERVERS,
  MCP_CONNECT_MANIFEST_MAX_CHARS,
  MCP_CONNECT_TOOL_NAME,
  createMcpConnectTool,
  type McpConnectManager,
  type McpLastKnownToolList,
} from './connect-mcp-server'

/** 同一个 manager 上"没接探针"的那份 skill —— 一切增量都相对它来量。 */
function baselineSkill(manager: McpConnectManager) {
  return createMcpConnectTool(manager).skill
}

describe('connect_mcp_server · manifest 层 · 一行状态摘要', () => {
  it('只报未连接总数与提示，不逐条列有清单服务的工具名或服务名', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [lastKnownList('weather', ['forecast', 'alerts'])],
    }).skill

    expect(description).toContain('当前 1 个已配置的 MCP 服务未连接')
    expect(description).toContain('已知工具已直接出现在工具清单里，可直接调用')
    // 超出这一句之外的细节去哪儿取，也要写在 manifest 里。
    expect(description).toContain('request_tool_schema')
    // 逐条工具名与服务名不再出现——那些已经是占位工具自己的注册名，manifest 说一遍就是双倍付费。
    expect(description).not.toContain('forecast')
    expect(description).not.toContain('alerts')
    expect(description).not.toContain('weather')
  })

  it('无已知清单的服务必须点名——它们没有占位，manifest 是唯一能看见它们的地方', () => {
    const { manager } = fakeManager([
      serverSnapshot('weather', 'disconnected'),
      serverSnapshot('db', 'disconnected'),
    ])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', ['forecast']),
        lastKnownList('db', [], { probeStatus: 'failed' }),
      ],
    }).skill

    expect(description).toContain('当前 2 个已配置的 MCP 服务未连接')
    expect(description).toContain('其中 1 个暂无已知清单（不等于没有工具，连上后才知道）：db')
    // 有清单的服务不在这条点名里——它已经是占位工具，不需要 manifest 再确认一次。
    expect(description).not.toContain('weather')
  })

  it('不重复列出已连接服务——它的工具已经在工具清单里了，且不计入未连接总数', () => {
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

    expect(description).toContain('当前 1 个已配置的 MCP 服务未连接')
    expect(description).not.toContain('weather')
    expect(description).not.toContain('github')
    expect(description).not.toContain('create_issue')
  })

  it('每次读描述都重新分类——服务从「无清单」变为「有清单」后立刻从点名列表里消失', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    let cache: readonly McpLastKnownToolList[] = []
    const tool = createMcpConnectTool(manager, { lastKnownTools: () => cache })

    expect(tool.skill.description).toContain('其中 1 个暂无已知清单')
    expect(tool.skill.description).toContain('weather')

    cache = [lastKnownList('weather', ['forecast'])]

    expect(tool.skill.description).not.toContain('其中')
    expect(tool.skill.description).not.toContain('weather')
    expect(tool.skill.description).toContain('当前 1 个已配置的 MCP 服务未连接')
  })
})

describe('connect_mcp_server · guide 层 · 诊断细节，不逐条列工具名', () => {
  it('给已知服务的探测时间与工具总数，不给任何单条工具名/描述', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', [{ name: 'forecast', description: '获取指定城市的天气预报' }]),
      ],
    }).skill

    expect(content).toContain(`weather —— 上次已知 ${CACHED_AT_TIMESTAMP} · 共 1 个工具`)
    expect(content).toContain('已经作为占位工具出现')
    expect(content).toContain('**这是历史，不是当前事实**')
    // 工具名与短描述不再重复——它们已经在占位工具自己的 description 里。
    expect(content).not.toContain('forecast')
    expect(content).not.toContain('获取指定城市的天气预报')
  })

  it('缓存侧截断过的清单，toolCount 仍反映真实总数（即使 tools 数组被截断）', () => {
    const { manager } = fakeManager([serverSnapshot('bulk', 'disconnected')])

    const { content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('bulk', ['a', 'b', 'c'], { toolCount: 24, truncated: true }),
      ],
    }).skill

    expect(content).toContain(`bulk —— 上次已知 ${CACHED_AT_TIMESTAMP} · 共 24 个工具`)
    expect(content).not.toContain(' a ')
  })

  it('无已知清单的服务：原因分三种，且明说「不是没有工具」', () => {
    const { manager } = fakeManager([
      serverSnapshot('db', 'error'),
      serverSnapshot('files', 'disconnected'),
      serverSnapshot('empty', 'disconnected'),
    ])

    const { content } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('db', [], { probeStatus: 'failed' }),
        lastKnownList('empty', []),
      ],
    }).skill

    expect(content).toContain('db（上次探测失败）')
    expect(content).toContain('files（尚未探测过）')
    expect(content).toContain('empty（上次探测到空清单）')
    expect(content).toContain('这些服务不是「没有工具」')
  })
})

describe('connect_mcp_server · 呈现侧上限', () => {
  it('manifest 的「无已知清单」ID 列表超限时留下痕迹，且总长度钉在上限内', () => {
    const gapServers = Array.from({ length: 30 }, (_unused, index) =>
      serverSnapshot(`gap-${index}`, 'disconnected'))
    const { manager } = fakeManager(gapServers)

    const { description } = createMcpConnectTool(manager, { lastKnownTools: () => [] }).skill

    expect(description).toContain('当前 30 个已配置的 MCP 服务未连接')
    expect(description).toMatch(/，以及另外 \d+ 个/)
    expect(description.length).toBeLessThanOrEqual(MCP_CONNECT_MANIFEST_MAX_CHARS)
  })

  it('guide 里已知服务超过每次展示上限时整条丢弃，并报出丢弃数', () => {
    const bulkCount = MCP_CONNECT_GUIDE_MAX_SERVERS + 10
    const bulkServers = Array.from({ length: bulkCount }, (_unused, index) =>
      serverSnapshot(`srv-${index}`, 'disconnected'))
    const bulkLists = bulkServers.map((server) => lastKnownList(server.id, ['tool']))
    const { manager } = fakeManager(bulkServers)

    const { content } = createMcpConnectTool(manager, { lastKnownTools: () => bulkLists }).skill

    const shownLines = [...content.matchAll(/srv-\d+ —— 上次已知/g)].length
    expect(shownLines).toBe(MCP_CONNECT_GUIDE_MAX_SERVERS)
    expect(content).toMatch(/还有 \d+ 个未连接服务因长度上限未列出/)
    expect(content.length).toBeLessThanOrEqual(MCP_CONNECT_GUIDE_MAX_CHARS)
  })
})

describe('connect_mcp_server · 探针未接线时的降级', () => {
  it('没接探针 → 描述与 guide 原样，一个字都不编', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description, content } = createMcpConnectTool(manager).skill

    expect(description).not.toContain('已配置的 MCP 服务未连接')
    expect(content).not.toContain('## 未连接服务的【上次已知】工具')
    expect(description).toContain('按需连接一个【已配置】的 MCP 服务')
    expect(description).toContain('显式预热')
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
    expect(description).not.toContain('已配置的 MCP 服务未连接')
  })

  it('缓存里残留的、已经被删掉的服务不会复活', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])

    const { description } = createMcpConnectTool(manager, {
      lastKnownTools: () => [
        lastKnownList('weather', ['forecast']),
        lastKnownList('removed-long-ago', ['ghost_tool']),
      ],
    }).skill

    // 只有登记表里的服务才计数；幽灵服务既不加进总数，也不会作为"无清单"被点名。
    expect(description).toContain('当前 1 个已配置的 MCP 服务未连接')
    expect(description).not.toContain('removed-long-ago')
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
    expect(summary?.description).toContain('当前 1 个已配置的 MCP 服务未连接')
    expect(summary?.description).not.toContain('weather')
    expect(summary?.description).not.toContain('天气预报')

    const loaded = registry.loadSchema(MCP_CONNECT_TOOL_NAME)
    expect(loaded?.guide).toContain(`weather —— 上次已知 ${CACHED_AT_TIMESTAMP}`)
    expect(loaded?.guide).not.toContain('- forecast —— 天气预报')
    expect(loaded?.guide).toContain('**这是历史，不是当前事实**')
  })

  it('不传探针时注册照常成功，只是描述里没有状态摘要', () => {
    const { manager } = fakeManager([serverSnapshot('weather', 'disconnected')])
    const registry = createToolRegistry()

    registerMcpTools(registry, { manager })

    const summary = registry.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)
    expect(summary?.description).not.toContain('已配置的 MCP 服务未连接')
  })
})
