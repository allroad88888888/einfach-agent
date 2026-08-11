import { rootStore } from '@web-agent/core/state/rootStore'
import { settingsCenterOpenAtom, settingsCenterTabAtom, type SettingsCenterTab } from './settingsCenterState'

export function openSettingsCenter(tab: SettingsCenterTab = 'mcp'): void {
  rootStore.setter(settingsCenterTabAtom, tab)
  rootStore.setter(settingsCenterOpenAtom, true)
}

export function closeSettingsCenter(): void {
  rootStore.setter(settingsCenterOpenAtom, false)
}

export function selectSettingsTab(tab: SettingsCenterTab): void {
  rootStore.setter(settingsCenterTabAtom, tab)
}
