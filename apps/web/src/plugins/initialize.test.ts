// 装配那一刻 isTauri() 答什么，插件面就接成什么（P10）。
//
// desktopProvider.test.ts 钉的是「provider 自己扫得对、装得对」，本文件钉的是另一件事：
// 生产装配到底有没有把它接上，以及 workspace root 变了会不会重扫。每个用例都要换一次宿主，
// 而装配按模块级 initialized 守卫只生效一次，所以照搬 mcp/initialize.storage.test.ts 的做法：
// 每个用例先 vi.resetModules() 拿一套全新模块实例，再让它重新走一遍「读 isTauri() → 选装配」。
//
// 桌面这一路走真的 scanPlugins + 真的 projectSkillsBridge，只把 Tauri IPC 这一层换成替身——
// 复用项目 skills 那条 Rust 通路正是本卡的做法，接错了这里就看不到 list_workspace_files。

import type { SessionMeta, WorkspaceMeta } from '@web-agent/core'
import type { HostInvoke } from '@web-agent/core/runtime/hostBridge'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 与真实模块一致的默认表现：isTauri() 答 false、invoke 不被意外调用。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

// H4c：desktopProvider.ts 装载的 buildProjectSkillsWorkspaceBridge 判据已经从 isTauriHost()
// 换成 hasHostBridge()（见 packages/agent-core/src/runtime/projectSkillsBridge.ts），继续切
// globalThis.isTauri 对它已经再无影响——那是 hasHostBridge() 换判据之前、这段注释原来描述的
// 旧机制。initializePluginSettings 自己的宿主门（initialize.ts 里的 isTauri()）仍走上面这层
// 模块 mock，两层各读各的，所以 freshHost 必须把两个开关一起切，否则「Tauri 宿主」用例里
// initialize.ts 判定为桌面、但 provider 内部的 workspace 文件桥仍判定为「没有桥」，扫不到
// 任何插件目录。
//
// hasHostBridge() 这半个开关**不能**改用 hostBridge.testHarness.ts 的 stubHostBridgeFlag：
// 那个桩的 loader 故意解析出一个恒 reject 的 invoke（它自己的 JSDoc 写明「需要 invoke 真的
// 返回数据的测试不该用本函数」），而本文件的断言恰恰要看 list_workspace_files 有没有真的带着
// 正确参数打到下面这份 @tauri-apps/api/core 的 invoke mock 上、hydration 有没有真的到
// status:'ready'——用 stubHostBridgeFlag 换掉之后实测两条「Tauri 宿主」用例会卡在
// hydration.status:'error'（error 里能看到 stub 的 reject 文案），listedRoots() 永远是空数组，
// invokeMock 一次都没被调用过。因此本文件直接调用 hostBridge.ts 导出的 configureHostInvoke，
// 登记一个把调用转发给下面这份 invoke mock 的 loader——这正是 hostBridge.ts 文件头注释里
// 「H5」那句「由桌面装配层把它的 loadTauriInvoke 包成一个 loader 注入进来」在测试里的等价物，
// 只是转发目标换成了本文件自己的 mock。
//
// 这半个开关同样不能在文件顶层静态 import 后直接调用：configureHostInvoke 操作的是
// hostBridge.ts 的模块级变量（hostInvokeLoader），而 freshHost 每次先 vi.resetModules()，
// 随后 `await import('./initialize')` 拿到的 desktopProvider.ts → projectSkillsBridge.ts →
// hostBridge.ts 是**重置后的新模块实例**；顶层静态 import 绑定的 configureHostInvoke 停留在
// 收集阶段那份**旧**实例上，调用它只改得动旧实例的状态，desktopProvider.ts 读到的新实例仍是
// 「没有桥」（与 uiStore 那条注释是同一类模块图不一致问题）。因此本文件不在顶层静态 import
// configureHostInvoke，而是像下面 uiStore 那样，在 freshHost 内部 vi.resetModules() 之后
// 再动态 import 一次，配合模块级可变引用接住这一代实例的 configureHostInvoke，供下面这个
// 模块顶层（收集阶段注册）的静态 afterEach 统一复位成「没有桥」（afterEach 本身必须在收集
// 阶段注册，不能等运行期才决定要不要挂）——写法上与旧版 stubTauriHostFlag 的「模块级可变引用
// + 静态 afterEach」同构，只是接住的是 configureHostInvoke 函数引用本身。
let currentConfigureHostInvoke: (loader: (() => Promise<HostInvoke>) | undefined) => void =
  () => {}

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
async function freshHost(tauriHost: boolean) {
  vi.resetModules()
  const tauriCore = await import('@tauri-apps/api/core')
  const isTauriMock = vi.mocked(tauriCore.isTauri)
  const invokeMock = vi.mocked(tauriCore.invoke)
  isTauriMock.mockReset()
  invokeMock.mockReset()
  isTauriMock.mockReturnValue(tauriHost)
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'list_workspace_files') return { entries: [], truncated: false }
    return undefined
  })
  // 必须从**重置后的模块图**动态 import：理由见上方文件头那段长注释。
  const { configureHostInvoke } = await import('@web-agent/core/runtime/hostBridge')
  currentConfigureHostInvoke = configureHostInvoke
  // tauriHost 为 true：登记一个转发到上面这份 invoke mock 的 loader，hasHostBridge() 由此
  // 答真，loadHostInvoke() 解析出的就是这份 mock 本身——workspaceRead 的四个调用点（H2）
  // 已经切到这条新链路。tauriHost 为 false：登记 undefined，回到「没有桥」。
  configureHostInvoke(tauriHost ? async () => invokeMock : undefined)

  const { initializePluginSettings } = await import('./initialize')
  const { hydratePluginSettings, isPluginSettingsConfigured } = await import('./commands')
  const { pluginHydrationAtom, pluginSettingsCapabilitiesAtom } = await import('./state')
  const { createMemoryPluginToggleStorage } = await import('./toggleStorage')
  // uiStore 也得从**重置后的模块图**里拿：vi.resetModules() 之后 ./commands 拿到的是新的那份，
  // 文件顶层静态 import 进来的是旧那份，两者不是同一个 store —— 断言会读到永远的默认值。
  const { uiStore } = await import('../uiStore')
  const { activeSessionIdAtom, rootStore, sessionsAtom, workspacesAtom } =
    await import('@web-agent/core/state/rootStore')

  return {
    initialize: (): void =>
      initializePluginSettings({ toggleStorage: createMemoryPluginToggleStorage() }),
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
  it('Tauri 宿主：装上真实 provider，workspace root 落定后扫 .webAgent/plugins/', async () => {
    const host = await freshHost(true)

    host.initialize()

    expect(host.isConfigured()).toBe(true)
    await host.hydrate()
    // 桌面恒支持插件：面板不再是"当前宿主不支持用户插件"的空态。
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

  it('Tauri 宿主：换一个 workspace 会重扫新目录，同一个 workspace 换会话不重扫', async () => {
    const host = await freshHost(true)
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

  it('浏览器预览：不装配，保持 P5 的 unsupported 默认，全程不碰 Tauri IPC', async () => {
    const host = await freshHost(false)
    host.seedWorkspaceRoot('/workspace/project')

    host.initialize()

    expect(host.isConfigured()).toBe(false)
    await host.hydrate()
    expect(host.capabilities()).toEqual({ supported: false })
    expect(host.invokeMock).not.toHaveBeenCalled()
  })
})
