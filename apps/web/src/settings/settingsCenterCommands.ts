import { uiStore } from '../uiStore'
import { settingsCenterOpenAtom, settingsCenterTabAtom, type SettingsCenterTab } from './settingsCenterState'

export function openSettingsCenter(tab: SettingsCenterTab = 'mcp'): void {
  uiStore.setter(settingsCenterTabAtom, tab)
  uiStore.setter(settingsCenterOpenAtom, true)
}

export function closeSettingsCenter(): void {
  uiStore.setter(settingsCenterOpenAtom, false)
}

export function selectSettingsTab(tab: SettingsCenterTab): void {
  uiStore.setter(settingsCenterTabAtom, tab)
}
