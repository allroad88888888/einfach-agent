import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import { disabledProjectSkillsByWorkspaceAtom } from '@einfach-agent/core'
import {
  createDefaultAppSettings,
  sanitizeCustomInstructions,
  type AppSettings,
} from './config'
import { resetModelCredentialState } from './modelCredentialState'
import { resetSettingsCenterState } from './settingsCenterState'
import { resetProjectSkillsSettingsState } from './projectSkillsState'

export {
  modelCredentialAtoms,
  modelCredentialHostAvailableAtom,
  modelCredentialEntriesAtom,
  type ModelCredentialEntry,
  type ModelCredentialEntries,
  type ModelCredentialState,
} from './modelCredentialState'

export {
  settingsCenterOpenAtom,
  settingsCenterTabAtom,
  type SettingsCenterTab,
} from './settingsCenterState'

export type SettingsFieldStatus =
  | { status: 'idle' | 'loading' | 'ready' | 'saved' }
  | { status: 'error'; error: string }

export type CustomInstructionsStatus = SettingsFieldStatus

export const appSettingsAtom = atom<AppSettings>(createDefaultAppSettings())
appSettingsAtom.debugLabel = 'appSettings'

export const customInstructionsAtom = atom(
  (get) => get(appSettingsAtom).agent.customInstructions,
  (get, set, value: string) => {
    const settings = get(appSettingsAtom)
    const customInstructions = sanitizeCustomInstructions(value)
    if (settings.agent.customInstructions === customInstructions) return
    set(appSettingsAtom, {
      ...settings,
      agent: {
        ...settings.agent,
        customInstructions,
      },
    })
  },
)
customInstructionsAtom.debugLabel = 'customInstructions'

export const customInstructionsDraftAtom = atom('')
customInstructionsDraftAtom.debugLabel = 'customInstructionsDraft'

export const customInstructionsStatusAtom = atom<CustomInstructionsStatus>({ status: 'idle' })
customInstructionsStatusAtom.debugLabel = 'customInstructionsStatus'

export const customInstructionsDirtyAtom = atom(
  (get) => get(customInstructionsDraftAtom) !== get(customInstructionsAtom),
)
customInstructionsDirtyAtom.debugLabel = 'customInstructionsDirty'

export function resetAppSettingsState(store: Store): void {
  store.setter(appSettingsAtom, createDefaultAppSettings())
  store.setter(customInstructionsDraftAtom, '')
  store.setter(customInstructionsStatusAtom, { status: 'idle' })
  store.setter(disabledProjectSkillsByWorkspaceAtom, {})
  resetProjectSkillsSettingsState(store)
  resetModelCredentialState(store)
  resetSettingsCenterState(store)
}

/** @deprecated 使用 resetAppSettingsState；保留别名兼容现有测试与调用方。 */
export function resetCustomInstructionsState(store: Store): void {
  resetAppSettingsState(store)
}
