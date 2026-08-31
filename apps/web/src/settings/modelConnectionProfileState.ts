import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import { MAX_MODEL_API_KEY_LENGTH } from './config'
import type { ConnectionProfileModel, ModelConnectionProfile } from './modelConnectionProfileHost'

export interface ModelConnectionProfileDraft {
  id: string
  label: string
  baseUrl: string
  models: readonly ConnectionProfileModel[]
  /** A transient password draft. It is never copied to `profiles`. */
  apiKey: string
}

export type ModelConnectionProfileStatus =
  | { status: 'idle' | 'loading' | 'ready' | 'saved' }
  | { status: 'error'; error: string }

export type ModelConnectionProfileProbeState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; models: readonly ConnectionProfileModel[] }
  | { status: 'error'; error: string }

export type ModelConnectionProfileEditorMode = 'closed' | 'create' | 'edit'

/** One UI-store value owns remote profiles, the current editor draft, and its operation state. */
export interface ModelConnectionProfileEntry {
  profiles: readonly ModelConnectionProfile[]
  editorMode: ModelConnectionProfileEditorMode
  draft: ModelConnectionProfileDraft
  state: ModelConnectionProfileStatus
  probe: ModelConnectionProfileProbeState
}

const probeGenerations = new WeakMap<Store, number>()

/** Keeps async probe completions scoped to the editor context that started them. */
export function modelConnectionProfileProbeGeneration(store: Store): number {
  return probeGenerations.get(store) ?? 0
}

export function invalidateModelConnectionProfileProbe(store: Store): void {
  probeGenerations.set(store, modelConnectionProfileProbeGeneration(store) + 1)
}

function emptyDraft(): ModelConnectionProfileDraft {
  return { id: '', label: '', baseUrl: '', models: [], apiKey: '' }
}

function initialEntry(): ModelConnectionProfileEntry {
  return {
    profiles: [], editorMode: 'closed', draft: emptyDraft(), state: { status: 'idle' },
    probe: { status: 'idle' },
  }
}

export const modelConnectionProfileEntryAtom = atom<ModelConnectionProfileEntry>(initialEntry())
modelConnectionProfileEntryAtom.debugLabel = 'modelConnectionProfileEntry'

export const modelConnectionProfileHostAvailableAtom = atom(false)
modelConnectionProfileHostAvailableAtom.debugLabel = 'modelConnectionProfileHostAvailable'

export const modelConnectionProfilesAtom = atom((get) => get(modelConnectionProfileEntryAtom).profiles)
modelConnectionProfilesAtom.debugLabel = 'modelConnectionProfiles'

export const modelConnectionProfileDraftAtom = atom(
  (get) => get(modelConnectionProfileEntryAtom).draft,
)
modelConnectionProfileDraftAtom.debugLabel = 'modelConnectionProfileDraft'

export const modelConnectionProfileEditorModeAtom = atom(
  (get) => get(modelConnectionProfileEntryAtom).editorMode,
)
modelConnectionProfileEditorModeAtom.debugLabel = 'modelConnectionProfileEditorMode'

export const modelConnectionProfileStatusAtom = atom(
  (get) => get(modelConnectionProfileEntryAtom).state,
)
modelConnectionProfileStatusAtom.debugLabel = 'modelConnectionProfileStatus'

export const modelConnectionProfileProbeStateAtom = atom(
  (get) => get(modelConnectionProfileEntryAtom).probe,
)
modelConnectionProfileProbeStateAtom.debugLabel = 'modelConnectionProfileProbeState'

export const modelConnectionProfileValidAtom = atom((get) => {
  const { id, label, baseUrl, models } = get(modelConnectionProfileEntryAtom).draft
  return [id, label, baseUrl].every((value) => value.trim().length > 0) && hasModelIds(models)
})
modelConnectionProfileValidAtom.debugLabel = 'modelConnectionProfileValid'

export const modelConnectionProfileDirtyAtom = atom((get) => {
  const { profiles, draft } = get(modelConnectionProfileEntryAtom)
  if (draft.apiKey.trim()) return true
  const remote = profiles.find((profile) => profile.id === draft.id)
  if (!remote) return [draft.id, draft.label, draft.baseUrl].some(
    (value) => value.trim().length > 0,
  ) || draft.models.length > 0
  return (
    remote.label !== draft.label.trim()
    || remote.baseUrl !== draft.baseUrl.trim()
    || !sameModels(remote.models, draft.models)
  )
})
modelConnectionProfileDirtyAtom.debugLabel = 'modelConnectionProfileDirty'

export function setModelConnectionProfileDraft(
  store: Store,
  patch: Partial<ModelConnectionProfileDraft>,
): void {
  const entry = store.getter(modelConnectionProfileEntryAtom)
  store.setter(modelConnectionProfileEntryAtom, {
    ...entry,
    draft: {
      ...entry.draft,
      ...patch,
      ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey.slice(0, MAX_MODEL_API_KEY_LENGTH) }),
    },
  })
}

export function setModelConnectionProfileState(
  store: Store,
  state: ModelConnectionProfileStatus,
): void {
  store.setter(modelConnectionProfileEntryAtom, {
    ...store.getter(modelConnectionProfileEntryAtom),
    state,
  })
}

export function setModelConnectionProfileProbeState(
  store: Store,
  probe: ModelConnectionProfileProbeState,
): void {
  store.setter(modelConnectionProfileEntryAtom, {
    ...store.getter(modelConnectionProfileEntryAtom),
    probe,
  })
}

export function setModelConnectionProfiles(
  store: Store,
  profiles: readonly ModelConnectionProfile[],
): void {
  store.setter(modelConnectionProfileEntryAtom, {
    ...store.getter(modelConnectionProfileEntryAtom),
    profiles: [...profiles],
  })
}

export function resetModelConnectionProfileDraft(store: Store): void {
  setModelConnectionProfileDraft(store, emptyDraft())
}

/** Opens a blank editor and explicitly drops any abandoned password draft. */
export function openCreateModelConnectionProfileEditor(store: Store): void {
  invalidateModelConnectionProfileProbe(store)
  const entry = store.getter(modelConnectionProfileEntryAtom)
  store.setter(modelConnectionProfileEntryAtom, {
    ...entry,
    editorMode: 'create',
    draft: emptyDraft(),
    probe: { status: 'idle' },
  })
}

/** Starts editing a public profile. Credentials are never prefilled or read back. */
export function openEditModelConnectionProfileEditor(
  store: Store,
  profile: ModelConnectionProfile,
): void {
  invalidateModelConnectionProfileProbe(store)
  const entry = store.getter(modelConnectionProfileEntryAtom)
  store.setter(modelConnectionProfileEntryAtom, {
    ...entry,
    editorMode: 'edit',
    draft: {
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      models: profile.models.map((model) => ({ ...model })),
      apiKey: '',
    },
    probe: { status: 'idle' },
  })
}

/** Cancelling or completing an editor operation leaves no password draft behind. */
export function closeModelConnectionProfileEditor(store: Store): void {
  invalidateModelConnectionProfileProbe(store)
  const entry = store.getter(modelConnectionProfileEntryAtom)
  store.setter(modelConnectionProfileEntryAtom, {
    ...entry,
    editorMode: 'closed',
    draft: emptyDraft(),
    probe: { status: 'idle' },
  })
}

export function resetModelConnectionProfileState(store: Store): void {
  invalidateModelConnectionProfileProbe(store)
  store.setter(modelConnectionProfileEntryAtom, initialEntry())
}

export function hasModelIds(models: readonly ConnectionProfileModel[]): boolean {
  return models.length > 0 && models.every((model) => model.id.trim().length > 0)
}

function sameModels(
  left: readonly ConnectionProfileModel[],
  right: readonly ConnectionProfileModel[],
): boolean {
  return left.length === right.length && left.every((model, index) => {
    const other = right[index]
    return other !== undefined
      && model.id === other.id.trim()
      && model.label === other.label.trim()
      && model.source === other.source
  })
}
