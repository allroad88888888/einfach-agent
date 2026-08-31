import { uiStore } from '../uiStore'
import { closeModelConnectionProfileEditor } from './modelConnectionProfileState'
import { settingsCenterOpenAtom, settingsCenterTabAtom, type SettingsCenterTab } from './settingsCenterState'

export function openSettingsCenter(tab: SettingsCenterTab = 'mcp'): void {
  uiStore.setter(settingsCenterTabAtom, tab)
  uiStore.setter(settingsCenterOpenAtom, true)
}

export function closeSettingsCenter(): void {
  uiStore.setter(settingsCenterOpenAtom, false)
  // The API key is a write-only, transient draft. Closing settings is also an
  // abandon action, regardless of which dialog interaction initiated it.
  closeModelConnectionProfileEditor(uiStore)
}

export function selectSettingsTab(tab: SettingsCenterTab): void {
  uiStore.setter(settingsCenterTabAtom, tab)
}
