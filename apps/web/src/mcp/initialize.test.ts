// 冷启动这条真链路：磁盘上的工具名缓存 → 进程内快照 → 模型看得见的两处 + 设置面板（B5）。
//
// toolProbeWiring.test.ts 证明的是「组装函数把线接对了」，本文件证明的是「生产装配真的调了它，
// 而且取数口一路通到磁盘」——两根线里任何一根被从 initialize.ts 里删掉，这里都会红。
// 走的是真的 initializeMcpSettings()、真的 toolRegistry、真的 defaultCore.config、
// 真的 localStorage 存储通道，只有 MCP 服务本身不存在（全程不连接）。

import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { rootStore } from '@web-agent/core/state/rootStore'
import { beforeEach, describe, expect, it } from 'vitest'
import { MCP_CONNECT_TOOL_NAME } from '@web-agent/tools-mcp'
import { hydrateMcpSettings } from './commands'
import { initializeMcpSettings } from './initialize'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import { mcpServersAtom } from './state'

const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)

/** 上一次运行留下的东西：一个已配置但【从没连过】的服务，加它上次已知的工具清单。 */
function seedColdStart(): void {
  window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
    version: 1,
    servers: [{
      id: 'docs',
      name: '文档服务',
      transport: 'streamable-http',
      url: 'https://docs.example.test/mcp',
      // 冷启动不连接：本测试要证明的正是「没连上也知道它有什么」。
      autoConnect: false,
    }],
  }))
  window.localStorage.setItem('web-agent.mcp-tool-name-cache.v1', JSON.stringify({
    version: 1,
    cache: {
      docs: {
        tools: [
          { name: 'search', description: '搜索文档' },
          { name: 'draft', description: '起草文档' },
        ],
        toolCount: 2,
        cachedAt: CACHED_AT,
        probeStatus: 'success',
      },
    },
  }))
}

function connectToolDescription(): string {
  return toolRegistry.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)?.description ?? ''
}

describe('MCP 冷启动装配 · 缓存一路走到模型与界面（B5）', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    seedColdStart()
    // 装配是幂等的（isMcpSettingsConfigured 守卫），重复调用只有第一次生效。
    initializeMcpSettings()
    await hydrateMcpSettings()
  })

  it('B4：模型点名调用缓存里的工具，运行时答「该服务未连接」而不是 unknown tool', () => {
    const probe = defaultCore.config.unconnectedToolProvider
    expect(probe).toBeTypeOf('function')

    expect(probe?.('mcp__docs__search')).toEqual({ serverId: 'docs', cachedAt: CACHED_AT })
    // 缓存里没有的名字照旧走 core 的未知工具老路——绝不凭空断言存在某个未连接服务。
    expect(probe?.('mcp__docs__publish')).toBeUndefined()
    expect(probe?.('write_file')).toBeUndefined()
  })

  it('F4：未连接服务的工具名进 connect_mcp_server 的描述，模型才知道该连哪个', () => {
    const description = connectToolDescription()

    expect(description).toContain('docs')
    expect(description).toContain('search')
    expect(description).toContain('draft')
    expect(description).toContain('上次已知')
  })

  it('设置面板：未连接的服务带着上次已知清单进服务视图', () => {
    const server = rootStore.getter(mcpServersAtom).find((entry) => entry.id === 'docs')

    expect(server?.status).toBe('disconnected')
    // 当前连接的工具数仍是 0（它确实没连上），历史挂在另一个字段上，两者不混。
    expect(server?.toolCount).toBe(0)
    expect(server?.lastKnownTools).toEqual({
      serverId: 'docs',
      tools: [
        { name: 'search', description: '搜索文档' },
        { name: 'draft', description: '起草文档' },
      ],
      toolCount: 2,
      truncated: false,
      cachedAt: CACHED_AT,
      probeStatus: 'success',
    })
  })
})
