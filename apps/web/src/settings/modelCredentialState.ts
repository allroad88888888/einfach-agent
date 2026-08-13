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

function createCredentialAtoms(id: ModelCredentialId) {
  const draft = credentialDraftAtom(id, `${id}Draft`)
  const status = atom((get) => get(modelCredentialEntriesAtom)[id].state)
  status.debugLabel = `${id}Status`
  const dirty = atom(
    (get) => get(modelCredentialEntriesAtom)[id].draft.trim().length > 0,
  )
  dirty.debugLabel = `${id}Dirty`
  return { draft, status, dirty }
}

const credentialAtomsById = new Map<ModelCredentialId, ReturnType<typeof createCredentialAtoms>>()

/**
 * 取某条凭据的 draft / status / dirty atom；同一 id 恒返回同一组实例（订阅身份稳定）。
 * 凭据按 id 取用，界面与状态层都不需要按厂商各写一份 atom。
 */
export function modelCredentialAtoms(id: ModelCredentialId) {
  const existing = credentialAtomsById.get(id)
  if (existing) return existing
  const created = createCredentialAtoms(id)
  credentialAtomsById.set(id, created)
  return created
}
