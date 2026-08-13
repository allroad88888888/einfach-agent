// apps/web/src/plugins/service.ts —— 插件设置面板的编排层
// ---------------------------------------------------------------------------
// 把注入的 PluginSettingsProvider（P10 会接桌面真实加载器，本卡用内存 fixture）
// 与 PluginToggleStorage 接到 state.ts 的 atom 上：hydrate 拉一次快照并按用户存储
// 里的停用记录立即 dispose 掉应停用的项；enable/disable 分别调用 provider.enable
// 与 LoadedPlugin.dispose，并把结果写回 atom。组织方式对齐 apps/web/src/mcp/service.ts，
// 但插件不需要连接队列/订阅这些 MCP 特有的复杂度，规模小很多。

import type { Store } from '@einfach/core'
import {
  pluginHydrationAtom,
  pluginOperationsAtom,
  pluginRowsAtom,
  pluginSettingsCapabilitiesAtom,
} from './state'
import type {
  LoadedPlugin,
  PluginRow,
  PluginRowStatus,
  PluginSettingsProvider,
  PluginToggleRecord,
  PluginToggleStorage,
} from './types'

export interface PluginSettingsService {
  hydrate(): Promise<void>
  enable(dirName: string): Promise<void>
  disable(dirName: string): Promise<void>
  dispose(): void
}

export interface CreatePluginSettingsServiceOptions {
  store: Store
  provider: PluginSettingsProvider
  toggleStorage: PluginToggleStorage
}

function deriveStatus(item: LoadedPlugin, disabled: PluginToggleRecord): PluginRowStatus {
  if (item.status === 'incompatible') return 'incompatible'
  if (item.status === 'failed') return item.id === undefined ? 'invalid' : 'failed'
  // item.status === 'enabled'：manifest 解析成功过，identity 必然存在（见 pluginLoader.ts）。
  if (item.id !== undefined && disabled[item.id]) return 'disabled'
  return 'enabled'
}

function toRow(item: LoadedPlugin, disabled: PluginToggleRecord): PluginRow {
  const status = deriveStatus(item, disabled)
  return {
    dirName: item.dirName,
    ...(item.id !== undefined ? { id: item.id } : {}),
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.version !== undefined ? { version: item.version } : {}),
    status,
    diagnostics: item.diagnostics,
    withheldToolsCount: item.withheldTools.length,
    toggleable: status === 'enabled' || status === 'disabled',
  }
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

  const writeRows = (): void => {
    if (disposed) return
    const disabledIds = toggleStorage.load()
    const rows = [...installed.values()]
      .sort((a, b) => a.dirName.localeCompare(b.dirName))
      .map((item) => toRow(item, disabledIds))
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
        const result = await provider.load()
        installed.clear()
        for (const item of result.plugins) installed.set(item.dirName, item)

        // 用户存储里的停用记录先于本次加载存在：provider.load() 不认识"停用"这个概念
        // （P4 的 loader 只产出 enabled/incompatible/failed），所以刚装完的项如果 id
        // 命中用户之前的停用记录，这里立即补一次 dispose，让运行时状态和面板要展示的
        // "disabled" 一致——不然会出现"面板说停用了，但 hook/工具其实还装着"的悬空态。
        const disabledIds = toggleStorage.load()
        for (const item of installed.values()) {
          if (item.status === 'enabled' && item.id !== undefined && disabledIds[item.id]) {
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
      toggleStorage.save({ ...toggleStorage.load(), [id]: true })
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
      let reinstalled: LoadedPlugin
      try {
        reinstalled = await provider.enable(dirName)
      } catch (error) {
        // provider 约定不抛异常（P4 的错误隔离纪律），但注入的实现不一定守约定——
        // 兜底降级为 failed，不让一个不听话的 provider 打断整张面板。
        reinstalled = {
          ...item,
          status: 'failed',
          diagnostics: [...item.diagnostics, `启用失败 — ${messageOf(error)}`],
          dispose: undefined,
        }
      }
      installed.set(dirName, reinstalled)
      const current = toggleStorage.load()
      if (id in current) {
        const next = { ...current }
        delete next[id]
        toggleStorage.save(next)
      }
      writeRows()
    } finally {
      setOperation(dirName)
    }
  }

  return {
    hydrate,
    enable,
    disable,
    dispose() {
      disposed = true
      for (const item of installed.values()) item.dispose?.()
      installed.clear()
    },
  }
}
