// 冷启动这条真链路：磁盘上的工具名缓存 → 进程内快照 → 模型看得见的两处 + 设置面板（B5）。
//
// toolProbeWiring.test.ts 证明的是「组装函数把线接对了」，本文件证明的是「生产装配真的调了它，
// 而且取数口一路通到磁盘」——两根线里任何一根被从 initialize.ts 里删掉，这里都会红。
// 走的是真的 initializeMcpSettings()、真的 toolRegistry、真的 defaultCore.config、
// 真的 localStorage 存储通道，只有 MCP 服务本身不存在（全程不连接）。

import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { classifyToolRisk } from '@web-agent/core/runtime/dangerousTools'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { rootStore } from '@web-agent/core/state/rootStore'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_CONNECT_TOOL_NAME } from '@web-agent/tools-mcp'
import { hydrateMcpSettings } from './commands'
import { initializeMcpSettings } from './initialize'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import { mcpServersAtom } from './state'
import { stdioLaunchFingerprint } from './stdioLaunchConsent'

// B1 的 Tauri 宿主用例需要 isTauri() 在装配那一刻就答「是」，其余用例（包括本文件
// 已有的浏览器宿主套件）仍要看到与真实模块一致的行为——默认返回 false、invoke 不被
// 意外调用，因此这里只换成可控的 mock，不改变默认表现。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

const CACHED_AT = Date.UTC(2026, 7, 10, 9, 30, 0)

/** 用户从不可信来源导入的一份 JSON：躺在配置里，从没点开过确认弹窗。 */
const UNSEEN_STDIO = {
  id: 'imported',
  name: '导入的服务',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@imported/from-untrusted-json'],
  autoConnect: false,
}

/** 用户亲眼确认过这条命令行（H2 的确认落在指纹上）。 */
const SEEN_STDIO = {
  id: 'approved',
  name: '确认过的服务',
  transport: 'stdio' as const,
  command: 'node',
  args: ['/Users/me/tools/server.js', '--stdio'],
  autoConnect: false,
}

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
    }, UNSEEN_STDIO, {
      ...SEEN_STDIO,
      launchConsent: {
        fingerprint: stdioLaunchFingerprint({ ...SEEN_STDIO, autoConnect: false }),
        approvedAt: CACHED_AT,
      },
    }],
  }))
  window.localStorage.setItem('web-agent.mcp-tool-name-cache.v1', JSON.stringify({
    version: 1,
    cache: {
      docs: {
        // 磁盘上存的是【注册名】：写入侧 toCachedTools 存的就是 McpToolSnapshot.name，
        // 模型点名调用时给的也是它。种远端原名会让 B4 那条断言测不到真实数据形状。
        tools: [
          { name: 'mcp__docs__search', description: '搜索文档' },
          { name: 'mcp__docs__draft', description: '起草文档' },
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

  /**
   * F8：模型这条路上的起进程确认。装配期接进 core 的探针必须带上「这条启动命令确认过没有」，
   * 否则用户从不可信来源导入的一份 JSON，在 Auto 模式下会被 connect_mcp_server 静默执行。
   *
   * 断言用真的 defaultCore.config.mcpConnectTarget（initialize.ts 接的那一根）跑 core 的分级：
   * initialize.ts 里 isLaunchConsented 那根线被拿掉，第二条就会红。
   */
  it('F8：从未确认过的 stdio 服务 → requiresConfirmation（Auto 模式也要暂停）', () => {
    const mcpConnectTarget = defaultCore.config.mcpConnectTarget
    expect(mcpConnectTarget).toBeTypeOf('function')

    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'imported' },
      { mcpConnectTarget },
    )

    expect(risk).toMatchObject({ level: 'dangerous', requiresConfirmation: true })
    expect(risk.reason).toContain('npx -y @imported/from-untrusted-json')
  })

  it('F8：确认过的 stdio 服务仍是普通 dangerous，不额外打断 Auto', () => {
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'approved' },
      { mcpConnectTarget: defaultCore.config.mcpConnectTarget },
    )

    expect(risk.level).toBe('dangerous')
    expect(risk.requiresConfirmation).toBeUndefined()
    expect(risk.reason).toContain('node /Users/me/tools/server.js --stdio')
  })

  it('F8：HTTP 服务不受影响，仍然 safe', () => {
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'docs' },
      { mcpConnectTarget: defaultCore.config.mcpConnectTarget },
    )).toEqual({ level: 'safe' })
  })

  it('设置面板：未连接的服务带着上次已知清单进服务视图', () => {
    const server = rootStore.getter(mcpServersAtom).find((entry) => entry.id === 'docs')

    expect(server?.status).toBe('disconnected')
    // 当前连接的工具数仍是 0（它确实没连上），历史挂在另一个字段上，两者不混。
    expect(server?.toolCount).toBe(0)
    expect(server?.lastKnownTools).toEqual({
      serverId: 'docs',
      tools: [
        { name: 'mcp__docs__search', description: '搜索文档' },
        { name: 'mcp__docs__draft', description: '起草文档' },
      ],
      toolCount: 2,
      truncated: false,
      cachedAt: CACHED_AT,
      probeStatus: 'success',
    })
  })
})

describe('装配点接入桌面配置文件存储（B1）', () => {
  // initializeMcpSettings() 按 isMcpSettingsConfigured() 只装配一次；本文件前面的套件已经
  // 在浏览器宿主下装配过，要让 initialize.ts 重新走一遍「读 isTauri() → 选 storage」的判断，
  // 必须换一套全新的模块实例，否则读到的永远是已经装配好的旧 service。
  it('Tauri 宿主下，服务配置的读写都经 mcp_config_read / mcp_config_write，不落 localStorage', async () => {
    vi.resetModules()
    // vi.resetModules() 只清真实模块的缓存，不清 vi.mock() 造出来的替身——isTauri/invoke
    // 这两个 mock 是整个文件共用的同一对象，调用记录必须自己清，否则会带着别的用例的历史。
    const tauriCore = await import('@tauri-apps/api/core')
    const isTauriMock = vi.mocked(tauriCore.isTauri)
    const invokeMock = vi.mocked(tauriCore.invoke)
    isTauriMock.mockReset()
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)

    const remoteConfig = {
      id: 'remote-desktop',
      name: '桌面配置里的服务',
      transport: 'streamable-http' as const,
      url: 'https://desktop.example.test/mcp',
      autoConnect: false,
    }
    // 未识别的命令一律答 undefined 而不是抛错：这条链路上还并行挂着工具名缓存的
    // mcp_config_read/mcp_config_write（B5，走同一对 command），本用例只关心
    // 服务配置这一路，不想因为没模到另一路而让 hydrate 整体失败。
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_config_read') return { servers: [remoteConfig], toolNameCache: {} }
      return undefined
    })

    window.localStorage.clear()

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh } =
      await import('./commands')

    initializeFresh()
    await hydrateFresh()

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    // 装配读到的服务确实来自 mcp_config_read，不是 localStorage 里的旧数据。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()

    await removeFresh('remote-desktop')

    const writeCalls = invokeMock.mock.calls.filter(([command]) => command === 'mcp_config_write')
    expect(writeCalls).toContainEqual(['mcp_config_write', { patch: { servers: [] } }])
    // 全程没有一次写落到浏览器存储。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
  })

  it('浏览器宿主下行为不变：装配仍走 localStorage 读写，不触碰 invoke', async () => {
    vi.resetModules()
    const tauriCore = await import('@tauri-apps/api/core')
    const isTauriMock = vi.mocked(tauriCore.isTauri)
    const invokeMock = vi.mocked(tauriCore.invoke)
    isTauriMock.mockReset()
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(false)

    window.localStorage.clear()
    // 与上一个用例对称：直接在 localStorage 里放一份既有配置，证明装配读到的是
    // 浏览器存储而不是 mcp_config_read。
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: 1,
      servers: [{
        id: 'browser-local',
        name: '浏览器里的服务',
        transport: 'streamable-http',
        url: 'https://browser.example.test/mcp',
        autoConnect: false,
      }],
    }))

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh } =
      await import('./commands')

    initializeFresh()
    await hydrateFresh()
    expect(invokeMock).not.toHaveBeenCalled()

    await removeFresh('browser-local')

    expect(invokeMock).not.toHaveBeenCalled()
    const stored = JSON.parse(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY) ?? '{}')
    expect(stored.servers).toEqual([])
  })
})
