import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import {
  createDefaultAppSettings,
  MAX_MODEL_API_KEY_LENGTH,
  sanitizeCustomInstructions,
  type AppSettings,
} from './config'
import type { CredentialSource } from './modelCredentialHost'

export type SettingsFieldStatus =
  | { status: 'idle' | 'loading' | 'ready' | 'saved' }
  | { status: 'error'; error: string }

export type CustomInstructionsStatus = SettingsFieldStatus

export type ModelCredentialState =
  | {
    status: 'idle' | 'loading' | 'ready' | 'saved'
    configured: boolean
    source: CredentialSource
  }
  | { status: 'error'; error: string; configured: false; source: 'missing' }

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

const deepSeekApiKeyDraftValueAtom = atom('')

export const deepSeekApiKeyDraftAtom = atom<string, [value: string], void>(
  (get) => get(deepSeekApiKeyDraftValueAtom),
  (_get, set, value) => set(
    deepSeekApiKeyDraftValueAtom,
    value.slice(0, MAX_MODEL_API_KEY_LENGTH),
  ),
)
deepSeekApiKeyDraftAtom.debugLabel = 'deepSeekApiKeyDraft'

export const deepSeekApiKeyStatusAtom = atom<ModelCredentialState>({
  status: 'idle',
  configured: false,
  source: 'missing',
})
deepSeekApiKeyStatusAtom.debugLabel = 'deepSeekApiKeyStatus'

export const deepSeekApiKeyDirtyAtom = atom(
  (get) => get(deepSeekApiKeyDraftAtom).trim().length > 0,
)
deepSeekApiKeyDirtyAtom.debugLabel = 'deepSeekApiKeyDirty'

export function resetAppSettingsState(store: Store): void {
  store.setter(appSettingsAtom, createDefaultAppSettings())
  store.setter(customInstructionsDraftAtom, '')
  store.setter(customInstructionsStatusAtom, { status: 'idle' })
  store.setter(deepSeekApiKeyDraftAtom, '')
  store.setter(deepSeekApiKeyStatusAtom, {
    status: 'idle',
    configured: false,
    source: 'missing',
  })
}

/** @deprecated 使用 resetAppSettingsState；保留别名兼容现有测试与调用方。 */
export function resetCustomInstructionsState(store: Store): void {
  resetAppSettingsState(store)
}
