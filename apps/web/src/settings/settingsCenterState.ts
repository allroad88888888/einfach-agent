import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'

export type SettingsCenterTab = 'mcp' | 'model' | 'instructions' | 'general' | 'skills'

export const settingsCenterOpenAtom = atom(false)
settingsCenterOpenAtom.debugLabel = 'settingsCenterOpen'

export const settingsCenterTabAtom = atom<SettingsCenterTab>('mcp')
settingsCenterTabAtom.debugLabel = 'settingsCenterTab'

export function resetSettingsCenterState(store: Store): void {
  store.setter(settingsCenterOpenAtom, false)
  store.setter(settingsCenterTabAtom, 'mcp')
}
