// apps/web/src/plugins/commands.ts —— 插件设置面板的公开命令面
// ---------------------------------------------------------------------------
// UI 只允许调这里导出的函数，不直接碰 service/atom 写入（对齐 apps/web/src/mcp/commands.ts
// 的既有纪律）。默认（未装配）状态下用一个"当前宿主不支持"的 provider 顶着——桌面真实接线
// 是 P10 的卡，在那之前任何宿主（包括还没跑 configurePluginSettings 的浏览器预览）看到的都是
// 明确的"不支持"空态，而不是一个假装能用但什么都不做的面板。

import { rootStore } from '@web-agent/core/state/rootStore'
import { createPluginSettingsService, type PluginSettingsService } from './service'
import { createLocalStoragePluginToggleStorage } from './toggleStorage'
import type { PluginSettingsProvider, PluginToggleStorage } from './types'

const unsupportedProvider: PluginSettingsProvider = {
  capabilities: { supported: false },
  load: async () => ({ plugins: [], unverified: [] }),
  enable: async (dirName) => {
    throw new Error(`当前宿主不支持用户插件，无法启用 ${dirName}`)
  },
}

let activeService: PluginSettingsService = createPluginSettingsService({
  store: rootStore,
  provider: unsupportedProvider,
  toggleStorage: createLocalStoragePluginToggleStorage(),
})
let configured = false

export interface ConfigurePluginSettingsOptions {
  provider: PluginSettingsProvider
  /** 默认桌面/浏览器走 localStorage；测试注入内存实现。 */
  toggleStorage?: PluginToggleStorage
}

export function configurePluginSettings({
  provider,
  toggleStorage = createLocalStoragePluginToggleStorage(),
}: ConfigurePluginSettingsOptions): void {
  activeService.dispose()
  configured = true
  activeService = createPluginSettingsService({ store: rootStore, provider, toggleStorage })
}

/** 供测试/诊断判断"是否已有宿主接线"，语义与 isMcpSettingsConfigured 对应。 */
export function isPluginSettingsConfigured(): boolean {
  return configured
}

export function hydratePluginSettings(): Promise<void> {
  return activeService.hydrate()
}

export function enablePlugin(dirName: string): Promise<void> {
  return activeService.enable(dirName)
}

export function disablePlugin(dirName: string): Promise<void> {
  return activeService.disable(dirName)
}
