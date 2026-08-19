// 装配那一刻宿主是哪一态，插件面就接成什么（P10；宿主门随 T1 吸收 B8 改判）。
//
// workspacePluginProvider.test.ts 钉的是「provider 自己扫得对、装得对」，本文件钉的是另一件事：
// 生产装配到底有没有把它接上，以及 workspace root 变了会不会重扫。每个用例都要换一次宿主，
// 而装配按模块级 initialized 守卫只生效一次，所以照搬 mcp/initialize.storage.test.ts 的做法：
// 每个用例先 vi.resetModules() 拿一套全新模块实例，再让它按递进来的 `host` 重新走一遍装配。
//
// 【T1（吸收 B8）改了什么】此前 `initializePluginSettings()` 无参，自己 `isTauri()` 探一次宿主，
// 于是本文件的开关是「摆布那个全局量」。现在它收 `ResolvedHost`（判据只有 resolveHost 一处），
// 而**有本机能力的那一态是 server**——「浏览器 + 本机 Node 后端」下用户插件本来就该在，此前是
// 被那一行 `isTauri()` 静默挡掉的。所以下面 server 那两条用例，跑的正是 B8 修好的那条路。
//
// server 这一路走真的 scanPlugins + 真的 projectSkillsBridge，只把宿主命令桥这一层换成替身——
// 复用项目 skills 那条通路正是本卡的做法，接错了这里就看不到 list_workspace_files。

import type { SessionMeta, WorkspaceMeta } from '@einfach-agent/core'
import type { HostInvoke } from '@einfach-agent/core/runtime/hostBridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from '../host/resolveHost'

const SERVER_HOST: ResolvedHost = { kind: 'server', platform: 'macos' }
const STATIC_HOST: ResolvedHost = { kind: 'static', reason: 'unreachable' }

// 宿主命令桥这半个开关**不能**用 hostBridge.testHarness.ts 的 stubHostBridgeFlag：那个桩的
// loader 故意解析出一个恒 reject 的 invoke（它自己的 JSDoc 写明「需要 invoke 真的返回数据的
// 测试不该用本函数」），而本文件的断言恰恰要看 list_workspace_files 有没有真的带着正确参数打到
// 下面那份 invoke 替身上、hydration 有没有真的到 status:'ready'——用 stubHostBridgeFlag 换掉之后
// 实测两条「有桥」用例会卡在 hydration.status:'error'（error 里能看到 stub 的 reject 文案），
// listedRoots() 永远是空数组，invokeMock 一次都没被调用过。因此本文件直接调用 hostBridge.ts 导出的
// configureHostInvoke，登记一个把调用转发给自己那份 invoke 替身的 loader——这正是生产装配层
// （host/hostCommandBridge.ts）那次登记在测试里的等价物，只是转发目标换成了本文件的 mock。
//
// 它同样不能在文件顶层静态 import 后直接调用：configureHostInvoke 操作的是
// hostBridge.ts 的模块级变量（hostInvokeLoader），而 freshHost 每次先 vi.resetModules()，
// 随后 `await import('./initialize')` 拿到的 workspacePluginProvider.ts → projectSkillsBridge.ts →
// hostBridge.ts 是**重置后的新模块实例**；顶层静态 import 绑定的 configureHostInvoke 停留在
// 收集阶段那份**旧**实例上，调用它只改得动旧实例的状态，workspacePluginProvider.ts 读到的新实例仍是
// 「没有桥」（与 uiStore 那条注释是同一类模块图不一致问题）。因此本文件不在顶层静态 import
// configureHostInvoke，而是像下面 uiStore 那样，在 freshHost 内部 vi.resetModules() 之后
// 再动态 import 一次，配合模块级可变引用接住这一代实例的 configureHostInvoke，供下面这个
// 模块顶层（收集阶段注册）的静态 afterEach 统一复位成「没有桥」（afterEach 本身必须在收集
// 阶段注册，不能等运行期才决定要不要挂）。
let currentConfigureHostInvoke: (
  registration: { loader: () => Promise<HostInvoke>; platform: 'macos' | 'linux' | 'windows' | 'unsupported' } | undefined,
) => void = () => {}

afterEach(() => {
  currentConfigureHostInvoke(undefined)
})

const WORKSPACE: WorkspaceMeta = {
  id: 'workspace-1',
  name: 'Project',
  rootPath: '/workspace/project',
  createdAt: 0,
  updatedAt: 0,
}

const SESSION: SessionMeta = {
  id: 'session-1',
  title: '插件装配',
  settings: { vendor: 'deepseek', model: 'deepseek-chat' },
  createdAt: 0,
  updatedAt: 0,
  workspaceId: WORKSPACE.id,
}

/** 换一套全新模块实例 + 一个可控宿主；插件根目录默认存在但为空（扫不出任何插件）。 */
async function freshHost(host: ResolvedHost) {
  vi.resetModules()
  const invokeMock = vi.fn(async (command: string) => {
    if (command === 'list_workspace_files') return { entries: [], truncated: false }
    return undefined
  }) as unknown as HostInvoke & ReturnType<typeof vi.fn>
  // 必须从**重置后的模块图**动态 import：理由见上方文件头那段长注释。
  const { configureHostInvoke } = await import('@einfach-agent/core/runtime/hostBridge')
  currentConfigureHostInvoke = configureHostInvoke
  // server 宿主：登记一个转发到上面那份 invoke 替身的 loader，hasHostBridge() 由此答真，
  // loadHostInvoke() 解析出的就是这份替身本身——workspaceRead 的四个调用点（H2）走的正是它。
  // static 宿主：登记 undefined，回到「没有桥」——与生产装配逐条对应（hostCommandBridge.ts）。
  configureHostInvoke(
    host.kind === 'server' ? { loader: async () => invokeMock, platform: 'macos' } : undefined,
  )

  const { initializePluginSettings } = await import('./initialize')
  const { hydratePluginSettings, isPluginSettingsConfigured } = await import('./commands')
  const { pluginHydrationAtom, pluginSettingsCapabilitiesAtom } = await import('./state')
  const { createMemoryPluginToggleStorage } = await import('./toggleStorage')
  // uiStore 也得从**重置后的模块图**里拿：vi.resetModules() 之后 ./commands 拿到的是新的那份，
  // 文件顶层静态 import 进来的是旧那份，两者不是同一个 store —— 断言会读到永远的默认值。
  const { uiStore } = await import('../uiStore')
  const { activeSessionIdAtom, rootStore, sessionsAtom, workspacesAtom } =
    await import('@einfach-agent/core/state/rootStore')

  return {
    initialize: (): void =>
      initializePluginSettings(host, { toggleStorage: createMemoryPluginToggleStorage() }),
    hydrate: hydratePluginSettings,
    isConfigured: isPluginSettingsConfigured,
    invokeMock,
    hydration: () => uiStore.getter(pluginHydrationAtom),
    capabilities: () => uiStore.getter(pluginSettingsCapabilitiesAtom),
    /** 每次 list_workspace_files 是冲哪个 workspace root 发的：重扫与否全看这条序列。 */
    listedRoots: (): unknown[] =>
      invokeMock.mock.calls
        .filter(([command]) => command === 'list_workspace_files')
        .map(([, args]) => (args as { workspace_root?: unknown } | undefined)?.workspace_root),
    seedWorkspaceRoot(rootPath: string): void {
      rootStore.setter(workspacesAtom, { [WORKSPACE.id]: { ...WORKSPACE, rootPath } })
      rootStore.setter(sessionsAtom, { [SESSION.id]: SESSION })
      rootStore.setter(activeSessionIdAtom, SESSION.id)
    },
  }
}

describe('插件运行时的宿主装配（P10）', () => {
  it('server 宿主：装上真实 provider，workspace root 落定后扫 .webAgent/plugins/', async () => {
    const host = await freshHost(SERVER_HOST)

    host.initialize()

    expect(host.isConfigured()).toBe(true)
    await host.hydrate()
    // 有本机能力的宿主恒支持插件：面板不再是"当前宿主不支持用户插件"的空态。
    // **这一条就是 B8 修好的那件事**：改判之前，同样这条路在 server 宿主下答的是 supported:false。
    expect(host.capabilities()).toEqual({ supported: true })
    // 启动这一刻 workspace 还没 hydrate 回来（root 为 undefined），第一次装配只能是空扫。
    expect(host.listedRoots()).toEqual([])

    host.seedWorkspaceRoot('/workspace/project')

    await vi.waitFor(() => {
      expect(host.listedRoots()).toEqual(['/workspace/project'])
    })
    expect(host.invokeMock).toHaveBeenCalledWith(
      'list_workspace_files',
      expect.objectContaining({ path: '.webAgent/plugins', workspace_root: '/workspace/project' }),
    )
    await vi.waitFor(() => {
      expect(host.hydration()).toEqual({ status: 'ready' })
    })
  })

  it('server 宿主：换一个 workspace 会重扫新目录，同一个 workspace 换会话不重扫', async () => {
    const host = await freshHost(SERVER_HOST)
    host.seedWorkspaceRoot('/workspace/one')
    host.initialize()

    await vi.waitFor(() => {
      expect(host.listedRoots()).toEqual(['/workspace/one'])
    })

    host.seedWorkspaceRoot('/workspace/two')
    await vi.waitFor(() => {
      expect(host.listedRoots()).toEqual(['/workspace/one', '/workspace/two'])
    })

    // 同一个 root 再写一次（切到同目录的另一个会话）：值没变就不该把插件拔掉再插一遍。
    host.seedWorkspaceRoot('/workspace/two')
    await Promise.resolve()
    expect(host.listedRoots()).toEqual(['/workspace/one', '/workspace/two'])
  })

  it('static 宿主：不装配，保持 P5 的 unsupported 默认，全程一条宿主命令都不发', async () => {
    const host = await freshHost(STATIC_HOST)
    host.seedWorkspaceRoot('/workspace/project')

    host.initialize()

    expect(host.isConfigured()).toBe(false)
    await host.hydrate()
    expect(host.capabilities()).toEqual({ supported: false })
    expect(host.invokeMock).not.toHaveBeenCalled()
  })
})
