import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import {
  createDefaultAppSettings,
  sanitizeCustomInstructions,
  sanitizeModelApiKey,
  type AppSettings,
} from './config'

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

export const deepSeekApiKeyAtom = atom(
  (get) => get(appSettingsAtom).providers.deepseek.apiKey,
  (get, set, value: string) => {
    const settings = get(appSettingsAtom)
    const apiKey = sanitizeModelApiKey(value)
    if (settings.providers.deepseek.apiKey === apiKey) return
    set(appSettingsAtom, {
      ...settings,
      providers: {
        ...settings.providers,
        deepseek: {
          ...settings.providers.deepseek,
          apiKey,
        },
      },
    })
  },
)
deepSeekApiKeyAtom.debugLabel = 'deepSeekApiKey'

export const deepSeekApiKeyDraftAtom = atom('')
deepSeekApiKeyDraftAtom.debugLabel = 'deepSeekApiKeyDraft'

export const deepSeekApiKeyStatusAtom = atom<SettingsFieldStatus>({ status: 'idle' })
deepSeekApiKeyStatusAtom.debugLabel = 'deepSeekApiKeyStatus'

export const deepSeekApiKeyDirtyAtom = atom(
  (get) => get(deepSeekApiKeyDraftAtom) !== get(deepSeekApiKeyAtom),
)
deepSeekApiKeyDirtyAtom.debugLabel = 'deepSeekApiKeyDirty'

export function resetAppSettingsState(store: Store): void {
  store.setter(appSettingsAtom, createDefaultAppSettings())
  store.setter(customInstructionsDraftAtom, '')
  store.setter(customInstructionsStatusAtom, { status: 'idle' })
  store.setter(deepSeekApiKeyDraftAtom, '')
  store.setter(deepSeekApiKeyStatusAtom, { status: 'idle' })
}

/** @deprecated 使用 resetAppSettingsState；保留别名兼容现有测试与调用方。 */
export function resetCustomInstructionsState(store: Store): void {
  resetAppSettingsState(store)
}
