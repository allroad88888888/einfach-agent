import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import { MAX_MODEL_API_KEY_LENGTH } from './config'
import {
  MODEL_CREDENTIALS,
  type CredentialSource,
  type ModelCredentialId,
} from './modelCredentialHost'

export type ModelCredentialState =
  | {
    status: 'idle' | 'loading' | 'ready' | 'saved'
    configured: boolean
    source: CredentialSource
  }
  | { status: 'error'; error: string; configured: false; source: 'missing' }

export interface ModelCredentialEntry {
  draft: string
  state: ModelCredentialState
}

export type ModelCredentialEntries = Record<ModelCredentialId, ModelCredentialEntry>

const EMPTY_STATE: ModelCredentialState = {
  status: 'idle',
  configured: false,
  source: 'missing',
}

function createInitialEntries(): ModelCredentialEntries {
  return Object.fromEntries(MODEL_CREDENTIALS.map(({ id }) => [
    id,
    { draft: '', state: { ...EMPTY_STATE } },
  ])) as ModelCredentialEntries
}

export const modelCredentialEntriesAtom = atom<ModelCredentialEntries>(createInitialEntries())
modelCredentialEntriesAtom.debugLabel = 'modelCredentialEntries'

export const modelCredentialHostAvailableAtom = atom(false)
modelCredentialHostAvailableAtom.debugLabel = 'modelCredentialHostAvailable'

export function setModelCredentialDraft(
  store: Store,
  id: ModelCredentialId,
  draft: string,
): void {
  const entries = store.getter(modelCredentialEntriesAtom)
  store.setter(modelCredentialEntriesAtom, {
    ...entries,
    [id]: {
      ...entries[id],
      draft: draft.slice(0, MAX_MODEL_API_KEY_LENGTH),
    },
  })
}

export function setModelCredentialStatus(
  store: Store,
  id: ModelCredentialId,
  state: ModelCredentialState,
): void {
  const entries = store.getter(modelCredentialEntriesAtom)
  store.setter(modelCredentialEntriesAtom, {
    ...entries,
    [id]: { ...entries[id], state },
  })
}

export function resetModelCredentialState(store: Store): void {
  store.setter(modelCredentialEntriesAtom, createInitialEntries())
}

function credentialDraftAtom(id: ModelCredentialId, debugLabel: string) {
  const result = atom<string, [value: string], void>(
    (get) => get(modelCredentialEntriesAtom)[id].draft,
    (get, set, value) => {
      const entries = get(modelCredentialEntriesAtom)
      set(modelCredentialEntriesAtom, {
        ...entries,
        [id]: {
          ...entries[id],
          draft: value.slice(0, MAX_MODEL_API_KEY_LENGTH),
        },
      })
    },
  )
  result.debugLabel = debugLabel
  return result
}

export const deepSeekApiKeyDraftAtom = credentialDraftAtom(
  'deepseek-default',
  'deepSeekApiKeyDraft',
)
export const deepSeekApiKeyStatusAtom = atom(
  (get) => get(modelCredentialEntriesAtom)['deepseek-default'].state,
)
deepSeekApiKeyStatusAtom.debugLabel = 'deepSeekApiKeyStatus'
export const deepSeekApiKeyDirtyAtom = atom(
  (get) => get(modelCredentialEntriesAtom)['deepseek-default'].draft.trim().length > 0,
)
deepSeekApiKeyDirtyAtom.debugLabel = 'deepSeekApiKeyDirty'

export const kimiApiKeyDraftAtom = credentialDraftAtom('kimi-cn', 'kimiApiKeyDraft')
export const kimiApiKeyStatusAtom = atom(
  (get) => get(modelCredentialEntriesAtom)['kimi-cn'].state,
)
kimiApiKeyStatusAtom.debugLabel = 'kimiApiKeyStatus'
export const kimiApiKeyDirtyAtom = atom(
  (get) => get(modelCredentialEntriesAtom)['kimi-cn'].draft.trim().length > 0,
)
kimiApiKeyDirtyAtom.debugLabel = 'kimiApiKeyDirty'
