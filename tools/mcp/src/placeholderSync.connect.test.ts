// 占位 + 真 manager 的合流判据（蓝图第五节的「头号阻塞项」）。
//
// 占位由同步器注册、不在 manager 的 registered 表里。如果 reconcile 只看「这个名字已经被别人
// 注册了」，那么【每一个有缓存清单的服务】一连接就会抛工具名冲突、被判成永久失败——占位一上线
// 就等于把所有 MCP 连接打死。这里用真的 McpClientManager 走一遍连接/断开，钉住三件事：
// 连接不冲突、真实工具原地覆盖占位、断开后占位回来。

import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { describe, expect, it } from 'vitest'
import { McpClientManager } from './clientManager'
import {
  FakeConnection,
  HTTP_CONFIG,
  ScriptedConnector,
  remoteTool,
} from './clientManager.reconnect.fixtures'
import type { McpLastKnownToolList } from './connect-mcp-server/lastKnownTools'
import { createMcpPlaceholderClaims } from './placeholderClaims'
import { createMcpPlaceholderSync } from './placeholderSync'
import { makeMcpToolName } from './toolAdapter'

const SEARCH = makeMcpToolName(HTTP_CONFIG.id, 'search')
/** 缓存里还留着一个远端已经下线的工具——占位有它，真实清单没有。 */
const GONE = makeMcpToolName(HTTP_CONFIG.id, 'gone')

function cachedList(): McpLastKnownToolList {
  return {
    serverId: HTTP_CONFIG.id,
    tools: [
      { name: SEARCH, description: '上次已知的搜索工具' },
      { name: GONE, description: '上次已知、现在没了的工具' },
    ],
    toolCount: 2,
    truncated: false,
    cachedAt: Date.UTC(2026, 7, 10),
    probeStatus: 'success',
  }
}

function setup() {
  const registry = createToolRegistry()
  const claims = createMcpPlaceholderClaims()
  const connector = new ScriptedConnector([
    new FakeConnection([remoteTool('search')]),
    new FakeConnection([remoteTool('search')]),
  ])
  // 同一个登记表实例递给两边——这正是「不这么接就 100% 连接失败」的那根线。
  const manager = new McpClientManager({ registry, connector, placeholders: claims })
  const sync = createMcpPlaceholderSync({
    registry,
    manager,
    claims,
    lastKnownTools: (serverId) => (serverId === HTTP_CONFIG.id ? cachedList() : undefined),
  })
  return {
    registry,
    claims,
    manager,
    sync,
    names: () => registry.list().map((entry) => entry.name).sort(),
  }
}

describe('占位与真实连接的合流', () => {
  it('只登记未连接：缓存清单变成占位', async () => {
    const wired = setup()

    await wired.manager.register(HTTP_CONFIG)

    expect(wired.names()).toEqual([GONE, SEARCH].sort())
    expect(wired.claims.namesFor(HTTP_CONFIG.id).sort()).toEqual([GONE, SEARCH].sort())
  })

  it('连接不再撞工具名冲突：真实工具原地覆盖同名占位，已消失的占位被注销', async () => {
    const wired = setup()
    await wired.manager.register(HTTP_CONFIG)
    const placeholder = wired.claims.get(SEARCH)?.tool

    const snapshot = await wired.manager.connect(HTTP_CONFIG)

    expect(snapshot.status).toBe('connected')
    // 同一个名字换成了真实实例，占位登记随之作废。
    expect(wired.registry.has(SEARCH, placeholder)).toBe(false)
    expect(wired.claims.get(SEARCH)).toBeUndefined()
    expect(wired.registry.list().find((entry) => entry.name === SEARCH)?.description)
      .toContain('External MCP tool "search"')
    // 服务一旦 connected，占位集合恒为空：缓存里那个已下线的工具不再挂在模型面前。
    expect(wired.names()).toEqual([SEARCH])
    expect(wired.claims.namesFor(HTTP_CONFIG.id)).toEqual([])
  })

  it('断开之后占位回来——「现在没连着」不是「这个服务没有工具」', async () => {
    const wired = setup()
    await wired.manager.register(HTTP_CONFIG)
    await wired.manager.connect(HTTP_CONFIG)

    await wired.manager.disconnect(HTTP_CONFIG.id)

    expect(wired.names()).toEqual([GONE, SEARCH].sort())
    expect(wired.claims.namesFor(HTTP_CONFIG.id).sort()).toEqual([GONE, SEARCH].sort())
  })
})
