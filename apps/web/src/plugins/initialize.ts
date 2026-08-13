// apps/web/src/plugins/initialize.ts —— 插件运行时的宿主装配（P10）
// ---------------------------------------------------------------------------
// 这里只回答一个问题：当前宿主要不要接真实插件加载面，接哪个 workspace 的。
// 加载语义在 desktopProvider.ts，求值策略在 desktopImportModule.ts。
//
// 与 MCP 同一条纪律（见 apps/web/src/mcp/initialize.ts 与 CLAUDE.md）：装配在应用启动时
// 发生，不等用户点开设置弹窗——插件注册的是 hook 与（勾选放行的）工具，等弹窗才装等于
// 「不打开设置的会话永远没有插件」。
//
// 非 Tauri（浏览器预览 / 静态产物）不装配：commands.ts 的默认 service 已经是一个如实回答
// 「当前宿主不支持用户插件」的 unsupported provider（蓝图 3.4：不为浏览器造读盘端点）。

import { atom } from '@einfach/core'
import { isTauri } from '@tauri-apps/api/core'
import { activeSessionMetaAtom, rootStore, workspacesAtom } from '@web-agent/core/state/rootStore'
import { resolveSessionWorkspaceRoot } from '@web-agent/core/state/workspaceState'
import { configurePluginSettings, hydratePluginSettings } from './commands'
import { createDesktopPluginSettingsProvider } from './desktopProvider'
import type { PluginToggleStorage } from './types'

/**
 * 扫哪个目录：当前会话的 workspace root。取的是与运行时同一个口径
 * （runtime/toolContext.ts 与 ProjectSkillsPanel 都用 resolveSessionWorkspaceRoot），
 * 不用 activeWorkspaceRootAtom——那是侧栏选中的工作区，与「这次 run 在哪跑」可以不一致，
 * 而插件装进的是跑 run 的那个 core。
 */
const pluginWorkspaceRootAtom = atom((get): string | undefined =>
  resolveSessionWorkspaceRoot(get(activeSessionMetaAtom), get(workspacesAtom)),
)

export interface InitializePluginSettingsOptions {
  /** 覆盖启停/勾选记录的存储（测试注入内存实现）；缺省走 commands.ts 的 localStorage。 */
  toggleStorage?: PluginToggleStorage
}

let initialized = false
let currentRoot: string | undefined

/**
 * 换一个 workspace root 重新装配。
 *
 * 必须整个 service 重建而不是「再 hydrate 一次」：hydrate 成功后是记忆化的（service.ts），
 * 而且旧 workspace 已经装上的插件得先卸掉——configurePluginSettings 会 dispose 旧 service，
 * 那一步正好把旧插件从 registry 与 plugin host 上撤下来。不这么做就会两个 workspace 的插件
 * 叠在同一个 core 上，工具重名还会让新插件装不进去。
 */
function configureForRoot(root: string | undefined, toggleStorage?: PluginToggleStorage): void {
  configurePluginSettings({
    provider: createDesktopPluginSettingsProvider({ workspaceRoot: root }),
    ...(toggleStorage ? { toggleStorage } : {}),
  })
  // 装配即扫描：插件要在用户打开设置面板之前就生效（面板 mount 时的那次 hydrate 会命中
  // 同一个记忆化 promise，不会重复扫）。失败已由 service 收进 hydration 状态，不抛给启动流程。
  void hydratePluginSettings()
}

/**
 * 桌面宿主接线入口。幂等：重复调用只有第一次生效（HMR、多处调用都不该重装一遍插件）。
 *
 * 启动时 workspace 通常还没 hydrate 回来（main.tsx 的 bootstrapApplication 是异步的），
 * 所以首次装配大概率绑定的是 undefined root（= 空清单）；真正的扫描发生在 root 落定后
 * 由下面这条订阅触发。用户之后切换会话/工作区同理。
 */
export function initializePluginSettings(options: InitializePluginSettingsOptions = {}): void {
  if (initialized) return
  if (!isTauri()) return
  initialized = true

  currentRoot = rootStore.getter(pluginWorkspaceRootAtom)
  configureForRoot(currentRoot, options.toggleStorage)

  rootStore.sub(pluginWorkspaceRootAtom, () => {
    const next = rootStore.getter(pluginWorkspaceRootAtom)
    // 会话切换但 workspace 没变（同目录的两个会话）不该重装插件：重装会先 dispose 一遍，
    // 把正在被 run 使用的 hook/工具在没有任何理由的情况下拔掉再插回去。
    if (next === currentRoot) return
    currentRoot = next
    configureForRoot(next, options.toggleStorage)
  })
}
