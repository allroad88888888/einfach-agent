// 装配那一刻 isTauri() 答什么，插件面就接成什么（P10）。
//
// desktopProvider.test.ts 钉的是「provider 自己扫得对、装得对」，本文件钉的是另一件事：
// 生产装配到底有没有把它接上，以及 workspace root 变了会不会重扫。每个用例都要换一次宿主，
// 而装配按模块级 initialized 守卫只生效一次，所以照搬 mcp/initialize.storage.test.ts 的做法：
// 每个用例先 vi.resetModules() 拿一套全新模块实例，再让它重新走一遍「读 isTauri() → 选装配」。
//
// 桌面这一路走真的 scanPlugins + 真的 projectSkillsBridge，只把 Tauri IPC 这一层换成替身——
// 复用项目 skills 那条 Rust 通路正是本卡的做法，接错了这里就看不到 list_workspace_files。

import type { SessionMeta, WorkspaceMeta } from '@web-agent/core/state/core.type'
import { describe, expect, it, vi } from 'vitest'

// 与真实模块一致的默认表现：isTauri() 答 false、invoke 不被意外调用。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

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

  const { initializePluginSettings } = await import('./initialize')
  const { hydratePluginSettings, isPluginSettingsConfigured } = await import('./commands')
  const { pluginHydrationAtom, pluginSettingsCapabilitiesAtom } = await import('./state')
  const { createMemoryPluginToggleStorage } = await import('./toggleStorage')
  const { activeSessionIdAtom, rootStore, sessionsAtom, workspacesAtom } =
    await import('@web-agent/core/state/rootStore')

  return {
    initialize: (): void =>
      initializePluginSettings({ toggleStorage: createMemoryPluginToggleStorage() }),
    hydrate: hydratePluginSettings,
    isConfigured: isPluginSettingsConfigured,
    invokeMock,
    hydration: () => rootStore.getter(pluginHydrationAtom),
    capabilities: () => rootStore.getter(pluginSettingsCapabilitiesAtom),
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
