import { uiStore } from '../uiStore'
// 冷启动这条真链路：磁盘上的工具名缓存 → 进程内快照 → 模型看得见的三处 + 设置面板（B5/D2/D3a）。
//
// toolProbeWiring.test.ts 证明的是「组装函数把线接对了」，本文件证明的是「生产装配真的调了它，
// 而且取数口一路通到磁盘」——那几根线里任何一根被从 initialize.ts 里删掉，这里都会红。
// 走的是真的 initializeMcpSettings(host)、真的 defaultCore.tools、真的 defaultCore.config、
// 真的 localStorage 存储通道，只有 MCP 服务本身不存在（全程不连接）。
//
// 存储后端的选择（B1：桌面 vs 浏览器）在 initialize.storage.test.ts，那是另一件事。

import { defaultCore, rootStore } from '@einfach-agent/core'
import type { ResolvedHost } from '../host/resolveHost'
import { classifyToolRisk } from '@einfach-agent/core/runtime/dangerousTools'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_CONNECT_TOOL_NAME } from '@einfach-agent/tools-mcp'
import { hydrateMcpSettings } from './commands'
import { initializeMcpSettings } from './initialize'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import { mcpServerConfigsAtom, mcpServersAtom } from './state'
import { stdioLaunchFingerprint } from './stdioLaunchConsent'

// 本文件全程是**没有本机能力的浏览器宿主**（`resolveHost()` 的 `static` 那一态），由下面这个
// 常量显式声明并递给装配点——宿主态的权威只有 `resolveHost()` 一处，装配点不自己探。
//
// `@tauri-apps/api/core` 仍要换成可控的替身：C7 之后装配路径上**一处宿主探测都不剩**（配置与
// 工具名缓存两份存储都由递进来的 `host` 分派），但 `initialize.ts` 的模块图里仍静态引着这个包，
// 而真实的 `invoke` 在 jsdom 里会去够 window 上的注入物——行为不该由环境决定。默认表现与真实
// 模块一致：`isTauri()` 答 false、`invoke` 不被调用。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

/** 本文件的宿主态：能打开页面，但没有任何本机能力。 */
const BROWSER_HOST: ResolvedHost = { kind: 'static', reason: 'unreachable' }

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
      // 两个 stdio 服务也有上次已知清单 → 冷启动后它们的占位工具就在 registry 里，
      // 模型可以直接点名调用，而那一次调用会先把进程拉起来（D3a 要守的正是这一步）。
      imported: {
        tools: [{ name: 'mcp__imported__run', description: '执行' }],
        toolCount: 1,
        cachedAt: CACHED_AT,
        probeStatus: 'success',
      },
      approved: {
        tools: [{ name: 'mcp__approved__run', description: '执行' }],
        toolCount: 1,
        cachedAt: CACHED_AT,
        probeStatus: 'success',
      },
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
  return defaultCore.tools.list().find((entry) => entry.name === MCP_CONNECT_TOOL_NAME)?.description ?? ''
}

describe('MCP 冷启动装配 · 缓存一路走到模型与界面（B5）', () => {
  beforeEach(async () => {
    window.localStorage.clear()
    seedColdStart()
    // 装配是幂等的（isMcpSettingsConfigured 守卫），重复调用只有第一次生效。
    initializeMcpSettings(BROWSER_HOST)
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

  // D4（commit b7ce69d）之后，connect_mcp_server 的描述不再逐条列出有已知清单的服务/工具名：
  // 三个种子服务（docs/imported/approved）都带着成功探测的缓存，其工具已经由 D2 的占位同步器
  // 以真名注册进 defaultCore.tools，描述本身收窄成一句状态摘要。新形态见
  // tools/mcp/src/connect-mcp-server/lastKnownToolsText.ts 与 connect-mcp-server.lastKnown.test.ts。
  it('F4：未连接服务计入 connect_mcp_server 描述的状态摘要，已知工具已经作为占位出现在工具清单里', () => {
    const description = connectToolDescription()

    expect(description).toContain('当前 3 个已配置的 MCP 服务未连接')
    expect(description).toContain('已知工具已直接出现在工具清单里，可直接调用')
    // 三个服务都有已知清单，均不再被点名——继续点名就是把占位工具的信息在这里多付一遍。
    expect(description).not.toContain('docs')
    expect(description).not.toContain('search')
    expect(description).not.toContain('draft')
    // 「模型看得见工具」这半截意图在本文件的装配环境里可以直接用真实 defaultCore.tools 验证：
    // 冷启动读盘之后，三个未连接服务的缓存清单都已经以占位工具的真名注册进去。
    expect(defaultCore.tools.has('mcp__docs__search')).toBe(true)
    expect(defaultCore.tools.has('mcp__docs__draft')).toBe(true)
    expect(defaultCore.tools.has('mcp__imported__run')).toBe(true)
    expect(defaultCore.tools.has('mcp__approved__run')).toBe(true)
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

  /**
   * D3a：模型直接调用一个未连接服务的占位工具，这一步会先把 stdio 服务拉起来。
   * 断言用真的 defaultCore.config.mcpToolLaunchTarget（toolProbeWiring 接的那一根）跑 core 的
   * 分级：占位注册与这根线任何一个从装配里掉出去，这条就会红。
   */
  it('D3a：未确认的 stdio 服务，占位调用 → requiresConfirmation（Auto 模式也要暂停）', () => {
    const mcpToolLaunchTarget = defaultCore.config.mcpToolLaunchTarget
    expect(mcpToolLaunchTarget).toBeTypeOf('function')
    // 占位真的注册了，模型看得见这个名字——否则下面这条分级只是空转。
    expect(defaultCore.tools.has('mcp__imported__run')).toBe(true)

    const risk = classifyToolRisk('mcp__imported__run', {}, { mcpToolLaunchTarget })

    expect(risk).toMatchObject({ level: 'dangerous', requiresConfirmation: true })
    expect(risk.reason).toContain('npx -y @imported/from-untrusted-json')
  })

  it('D3a：确认过的 stdio 服务，占位调用是普通 dangerous，不额外打断 Auto', () => {
    const risk = classifyToolRisk('mcp__approved__run', {}, {
      mcpToolLaunchTarget: defaultCore.config.mcpToolLaunchTarget,
    })

    expect(risk.level).toBe('dangerous')
    expect(risk.requiresConfirmation).toBeUndefined()
    expect(risk.reason).toContain('node /Users/me/tools/server.js --stdio')
  })

  it('D3a：HTTP 服务的占位调用维持既有 dangerous，Auto 直接执行（零回归）', () => {
    expect(classifyToolRisk('mcp__docs__search', {}, {
      mcpToolLaunchTarget: defaultCore.config.mcpToolLaunchTarget,
    })).toEqual({ level: 'dangerous' })
  })

  /**
   * 模型路径的确认【不】回写起进程指纹：指纹只由用户路径（设置里的确认卡片）写入，
   * 那是它「改了命令 = 确认作废」这一性质的单点来源。代价是同一个未确认服务在连上之前
   * 每次都会问一次——重复询问的上限是「每次连接一次」，可接受。
   */
  it('D3a：分级本身不写任何确认记录，未确认的服务下次仍然要问', () => {
    const mcpToolLaunchTarget = defaultCore.config.mcpToolLaunchTarget
    classifyToolRisk('mcp__imported__run', {}, { mcpToolLaunchTarget })

    expect(classifyToolRisk('mcp__imported__run', {}, { mcpToolLaunchTarget }).requiresConfirmation)
      .toBe(true)
    const imported = uiStore.getter(mcpServerConfigsAtom).find((entry) => entry.id === 'imported')
    expect(imported?.transport).toBe('stdio')
    expect(imported && 'launchConsent' in imported ? imported.launchConsent : undefined)
      .toBeUndefined()
  })

  it('设置面板：未连接的服务带着上次已知清单进服务视图', () => {
    const server = uiStore.getter(mcpServersAtom).find((entry) => entry.id === 'docs')

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
