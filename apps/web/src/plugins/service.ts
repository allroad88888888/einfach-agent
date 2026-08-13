// apps/web/src/plugins/service.ts —— 插件设置面板的编排层
// ---------------------------------------------------------------------------
// 把注入的 PluginSettingsProvider（P10 会接桌面真实加载器，本卡用内存 fixture）
// 与 PluginToggleStorage 接到 state.ts 的 atom 上：hydrate 拉一次快照并按用户存储
// 里的停用记录立即 dispose 掉应停用的项；enable/disable 分别调用 provider.enable
// 与 LoadedPlugin.dispose，setToolEnabled 改勾选记录后走同一条重装路径，让 P4 的闸门
// 按新记录重新算一遍放行/拦截。组织方式对齐 apps/web/src/mcp/service.ts，
// 但插件不需要连接队列/订阅这些 MCP 特有的复杂度，规模小很多。
//
// 行投影（LoadedPlugin + 记录 → PluginRow）在 rows.ts，本文件只管编排与副作用顺序。

import type { Store } from '@einfach/core'
import { isToolChecked, toRow, withPluginDisabled, withToolToggle } from './rows'
import {
  pluginHydrationAtom,
  pluginOperationsAtom,
  pluginRowsAtom,
  pluginSettingsCapabilitiesAtom,
} from './state'
import type {
  LoadedPlugin,
  PluginSettingsProvider,
  PluginToggleStorage,
  PluginToolGate,
} from './types'

export interface PluginSettingsService {
  hydrate(): Promise<void>
  enable(dirName: string): Promise<void>
  disable(dirName: string): Promise<void>
  /** 勾选/取消一个模型可见工具；插件仍装着时立即重装，让闸门按新记录放行或收回。 */
  setToolEnabled(dirName: string, toolName: string, enabled: boolean): Promise<void>
  dispose(): void
}

export interface CreatePluginSettingsServiceOptions {
  store: Store
  provider: PluginSettingsProvider
  toggleStorage: PluginToggleStorage
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginSettingsService({
  store,
  provider,
  toggleStorage,
}: CreatePluginSettingsServiceOptions): PluginSettingsService {
  // 真正装过的插件项（含 dispose 闭包），按 dirName 索引；只在 service 内部持有，
  // 绝不进 atom——atom 是给 UI 读的纯数据投影，函数引用不该跑到那一层。
  const installed = new Map<string, LoadedPlugin>()
  let disposed = false
  let hydratePromise: Promise<void> | undefined

  // 交给 provider（最终是 P4 loader）的闸门查询。每次调用重读存储：勾选变化后立刻重装，
  // 读的必须是刚写进去的那份记录，缓存一份反而要自己维护失效时机。
  const isToolEnabled: PluginToolGate = (pluginId, toolName) =>
    isToolChecked(toggleStorage.load().tools, pluginId, toolName)

  const writeRows = (): void => {
    if (disposed) return
    const state = toggleStorage.load()
    const rows = [...installed.values()]
      .sort((a, b) => a.dirName.localeCompare(b.dirName))
      .map((item) => toRow(item, state))
    store.setter(pluginRowsAtom, rows)
  }

  const setOperation = (dirName: string, operation?: 'enabling' | 'disabling'): void => {
    if (disposed) return
    store.setter(pluginOperationsAtom, (previous) => {
      if (!operation) {
        if (!(dirName in previous)) return previous
        const next = { ...previous }
        delete next[dirName]
        return next
      }
      return { ...previous, [dirName]: operation }
    })
  }

  /** 重跑一次安装：启用与工具勾选变化共用这一条路径，两者都是"按当前闸门重装一遍"。 */
  const reinstall = async (dirName: string, current: LoadedPlugin): Promise<LoadedPlugin> => {
    try {
      return await provider.enable(dirName, isToolEnabled)
    } catch (error) {
      // provider 约定不抛异常（P4 的错误隔离纪律），但注入的实现不一定守约定——
      // 兜底降级为 failed，不让一个不听话的 provider 打断整张面板。
      return {
        ...current,
        status: 'failed',
        diagnostics: [...current.diagnostics, `启用失败 — ${messageOf(error)}`],
        dispose: undefined,
      }
    }
  }

  const hydrate = (): Promise<void> => {
    if (hydratePromise) return hydratePromise
    let succeeded = false
    const attempt = (async () => {
      store.setter(pluginHydrationAtom, { status: 'loading' })
      store.setter(pluginSettingsCapabilitiesAtom, provider.capabilities)
      if (!provider.capabilities.supported) {
        installed.clear()
        writeRows()
        store.setter(pluginHydrationAtom, { status: 'ready' })
        succeeded = true
        return
      }
      try {
        const result = await provider.load(isToolEnabled)
        installed.clear()
        for (const item of result.plugins) installed.set(item.dirName, item)

        // 用户存储里的停用记录先于本次加载存在：provider.load() 不认识"停用"这个概念
        // （P4 的 loader 只产出 enabled/incompatible/failed），所以刚装完的项如果 id
        // 命中用户之前的停用记录，这里立即补一次 dispose，让运行时状态和面板要展示的
        // "disabled" 一致——不然会出现"面板说停用了，但 hook/工具其实还装着"的悬空态。
        // 工具勾选不需要这一步：它在 load() 里就经 isToolEnabled 生效了。
        const { disabled } = toggleStorage.load()
        for (const item of installed.values()) {
          if (item.status === 'enabled' && item.id !== undefined && disabled[item.id]) {
            item.dispose?.()
            installed.set(item.dirName, { ...item, dispose: undefined })
          }
        }
        writeRows()
        store.setter(pluginHydrationAtom, { status: 'ready' })
        succeeded = true
      } catch (error) {
        store.setter(pluginHydrationAtom, { status: 'error', error: messageOf(error) })
      }
    })()
    hydratePromise = attempt.finally(() => {
      if (!succeeded) hydratePromise = undefined
    })
    return hydratePromise
  }

  const disable = async (dirName: string): Promise<void> => {
    const item = installed.get(dirName)
    if (!item || item.id === undefined) return
    const id = item.id
    setOperation(dirName, 'disabling')
    try {
      item.dispose?.()
      installed.set(dirName, { ...item, dispose: undefined })
      toggleStorage.save(withPluginDisabled(toggleStorage.load(), id, true))
      writeRows()
    } finally {
      setOperation(dirName)
    }
  }

  const enable = async (dirName: string): Promise<void> => {
    const item = installed.get(dirName)
    if (!item || item.id === undefined) return
    const id = item.id
    setOperation(dirName, 'enabling')
    try {
      // 记录先落盘：重装期间 provider 会经 isToolEnabled 回读这份记录。
      toggleStorage.save(withPluginDisabled(toggleStorage.load(), id, false))
      installed.set(dirName, await reinstall(dirName, item))
      writeRows()
    } finally {
      setOperation(dirName)
    }
  }

  const setToolEnabled = async (
    dirName: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> => {
    const item = installed.get(dirName)
    if (!item || item.id === undefined) return
    const id = item.id
    const state = toggleStorage.load()
    if (isToolChecked(state.tools, id, toolName) === enabled) return
    toggleStorage.save(withToolToggle(state, id, toolName, enabled))

    // 用户已停用或本就没装成功的插件：只记录，等下次启用时由那条路径统一生效。
    // 硬要在这里重装等于替用户把插件又启用了一遍。
    if (item.status !== 'enabled' || state.disabled[id]) {
      writeRows()
      return
    }

    setOperation(dirName, 'enabling')
    try {
      // 先卸载再装：闸门只在注册期判定一次（见 pluginToolGate.ts），不重装就既放行不了
      // 新勾中的工具，也收不回刚取消的那个。
      item.dispose?.()
      installed.set(dirName, await reinstall(dirName, { ...item, dispose: undefined }))
      writeRows()
    } finally {
      setOperation(dirName)
    }
  }

  return {
    hydrate,
    enable,
    disable,
    setToolEnabled,
    dispose() {
      disposed = true
      for (const item of installed.values()) item.dispose?.()
      installed.clear()
    },
  }
}
