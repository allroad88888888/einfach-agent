// apps/web/src/plugins/state.ts —— 插件设置面板的 atom 定义
// ---------------------------------------------------------------------------
// 只放 atom 本身与复位函数，编排逻辑（hydrate/enable/disable）在 service.ts。
// 组织方式对齐 apps/web/src/mcp/state.ts：面板只读这些 atom，写入统一经 service。

import { atom } from '@einfach/react'
import type { Store } from '@einfach/core'
import type { PluginRow, PluginSettingsCapabilities } from './types'

export type PluginHydrationState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'error'; error: string }

/** 单行的进行中操作；用于禁用按钮和显示"停用中/启用中"，不进入 PluginRow 本身。 */
export type PluginOperation = 'enabling' | 'disabling'

export const pluginSettingsCapabilitiesAtom = atom<PluginSettingsCapabilities>({
  supported: false,
})
pluginSettingsCapabilitiesAtom.debugLabel = 'pluginSettingsCapabilities'

export const pluginHydrationAtom = atom<PluginHydrationState>({ status: 'idle' })
pluginHydrationAtom.debugLabel = 'pluginHydration'

export const pluginRowsAtom = atom<readonly PluginRow[]>([])
pluginRowsAtom.debugLabel = 'pluginRows'

export const pluginOperationsAtom = atom<Readonly<Record<string, PluginOperation>>>({})
pluginOperationsAtom.debugLabel = 'pluginOperations'

export function resetPluginSettingsState(store: Store): void {
  store.setter(pluginSettingsCapabilitiesAtom, { supported: false })
  store.setter(pluginHydrationAtom, { status: 'idle' })
  store.setter(pluginRowsAtom, [])
  store.setter(pluginOperationsAtom, {})
}
