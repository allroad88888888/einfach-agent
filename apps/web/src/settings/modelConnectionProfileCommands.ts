import { uiStore } from '../uiStore'
import { replaceOpenAiCompatConnections } from '../modelTransport/openAiCompatRegistry'
import {
  createUnavailableModelConnectionProfileHost,
  type ConnectionProfileModel,
  type ModelConnectionProfile,
  type ModelConnectionProfileHost,
  type ModelConnectionProfileSaveInput,
} from './modelConnectionProfileHost'
import {
  modelConnectionProfileEntryAtom,
  modelConnectionProfileHostAvailableAtom,
  closeModelConnectionProfileEditor,
  hasModelIds,
  invalidateModelConnectionProfileProbe,
  modelConnectionProfileProbeGeneration,
  openCreateModelConnectionProfileEditor as openCreateEditor,
  openEditModelConnectionProfileEditor as openEditEditor,
  resetModelConnectionProfileState,
  setModelConnectionProfileDraft,
  setModelConnectionProfiles,
  setModelConnectionProfileState,
  setModelConnectionProfileProbeState,
} from './modelConnectionProfileState'
import { synchronizeDefaultModelConnectionRuntime } from './defaultModelConnectionRuntime'

let activeHost = createUnavailableModelConnectionProfileHost()

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '模型连接操作失败'
}

function saveInput(): ModelConnectionProfileSaveInput | undefined {
  const { draft } = uiStore.getter(modelConnectionProfileEntryAtom)
  const input = {
    id: draft.id.trim(),
    label: draft.label.trim(),
    baseUrl: draft.baseUrl.trim(),
    models: draft.models.map((model) => ({
      id: model.id.trim(), label: model.label.trim(), source: model.source,
    })),
  }
  if (!input.id || !input.label || !input.baseUrl || !hasModelIds(input.models)) return undefined
  const apiKey = draft.apiKey.trim()
  return apiKey ? { ...input, apiKey } : input
}

function upsertProfile(profile: ModelConnectionProfile): void {
  const { profiles } = uiStore.getter(modelConnectionProfileEntryAtom)
  const present = profiles.some((candidate) => candidate.id === profile.id)
  const next = present
    ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
    : [...profiles, profile]
  setModelConnectionProfiles(uiStore, next)
  replaceOpenAiCompatConnections(next)
}

export function configureModelConnectionProfileHost(host: ModelConnectionProfileHost): void {
  activeHost = host
  uiStore.setter(modelConnectionProfileHostAvailableAtom, host.available)
  synchronizeDefaultModelConnectionRuntime()
}

export async function hydrateModelConnectionProfiles(): Promise<void> {
  setModelConnectionProfileState(uiStore, { status: 'loading' })
  try {
    const profiles = await activeHost.list()
    setModelConnectionProfiles(uiStore, profiles)
    replaceOpenAiCompatConnections(profiles)
    setModelConnectionProfileState(uiStore, { status: 'ready' })
    synchronizeDefaultModelConnectionRuntime()
  } catch (error) {
    setModelConnectionProfileState(uiStore, { status: 'error', error: errorMessage(error) })
    synchronizeDefaultModelConnectionRuntime()
  }
}

export function updateModelConnectionProfileDraft(
  patch: Parameters<typeof setModelConnectionProfileDraft>[1],
): void {
  const previousBaseUrl = uiStore.getter(modelConnectionProfileEntryAtom).draft.baseUrl.trim()
  setModelConnectionProfileDraft(uiStore, patch)
  if (patch.baseUrl !== undefined && patch.baseUrl.trim() !== previousBaseUrl) {
    invalidateModelConnectionProfileProbe(uiStore)
    setModelConnectionProfileProbeState(uiStore, { status: 'idle' })
  }
  setModelConnectionProfileState(uiStore, { status: 'ready' })
}

/** Probes the current endpoint without changing the user's selected draft models. */
export async function probeModelConnectionProfile(): Promise<boolean> {
  const { baseUrl, apiKey } = uiStore.getter(modelConnectionProfileEntryAtom).draft
  const generation = modelConnectionProfileProbeGeneration(uiStore)
  setModelConnectionProfileProbeState(uiStore, { status: 'loading' })
  try {
    const result = await activeHost.probe({
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    })
    if (generation !== modelConnectionProfileProbeGeneration(uiStore)) return false
    setModelConnectionProfileProbeState(uiStore, { status: 'ready', models: result.models.map((model) => ({ ...model })) })
    return true
  } catch (error) {
    if (generation !== modelConnectionProfileProbeGeneration(uiStore)) return false
    setModelConnectionProfileProbeState(uiStore, { status: 'error', error: errorMessage(error) })
    return false
  }
}

export function addManualModelConnectionProfileModel(id: string): void {
  const value = id.trim()
  if (!value) return
  const { draft } = uiStore.getter(modelConnectionProfileEntryAtom)
  if (draft.models.some((model) => model.id === value)) return
  replaceModelConnectionProfileModels([...draft.models, { id: value, label: value, source: 'manual' }])
}

export function removeModelConnectionProfileModel(id: string): void {
  const value = id.trim()
  const { draft } = uiStore.getter(modelConnectionProfileEntryAtom)
  replaceModelConnectionProfileModels(draft.models.filter((model) => model.id !== value))
}

export function replaceModelConnectionProfileModels(
  models: readonly ConnectionProfileModel[],
): void {
  setModelConnectionProfileDraft(uiStore, { models: models.map((model) => ({ ...model })) })
  setModelConnectionProfileState(uiStore, { status: 'ready' })
}

export function openCreateModelConnectionProfileEditor(): void {
  openCreateEditor(uiStore)
  setModelConnectionProfileState(uiStore, { status: 'ready' })
}

export function openEditModelConnectionProfileEditor(id: string): boolean {
  const profile = uiStore.getter(modelConnectionProfileEntryAtom).profiles.find(
    (candidate) => candidate.id === id,
  )
  if (!profile) {
    setModelConnectionProfileState(uiStore, { status: 'error', error: '要编辑的模型连接不存在。' })
    return false
  }
  openEditEditor(uiStore, profile)
  setModelConnectionProfileState(uiStore, { status: 'ready' })
  return true
}

export function resetModelConnectionProfileEditor(): void {
  closeModelConnectionProfileEditor(uiStore)
  setModelConnectionProfileState(uiStore, { status: 'ready' })
}

export function resetModelConnectionProfiles(): void {
  resetModelConnectionProfileState(uiStore)
  replaceOpenAiCompatConnections([])
}

export async function saveModelConnectionProfile(): Promise<boolean> {
  const input = saveInput()
  if (!input) {
    setModelConnectionProfileState(uiStore, {
      status: 'error', error: '请填写连接名称、ID、接入点地址并至少选择一个模型。',
    })
    return false
  }
  setModelConnectionProfileState(uiStore, { status: 'loading' })
  try {
    // The profile response has no API key; clear the transient password only after a successful write.
    upsertProfile(await activeHost.save(input))
    closeModelConnectionProfileEditor(uiStore)
    setModelConnectionProfileState(uiStore, { status: 'saved' })
    synchronizeDefaultModelConnectionRuntime()
    return true
  } catch (error) {
    setModelConnectionProfileState(uiStore, { status: 'error', error: errorMessage(error) })
    return false
  }
}

export async function deleteModelConnectionProfile(id: string): Promise<boolean> {
  const profileId = id.trim()
  if (!profileId) {
    setModelConnectionProfileState(uiStore, { status: 'error', error: '请选择要删除的模型连接。' })
    return false
  }
  setModelConnectionProfileState(uiStore, { status: 'loading' })
  try {
    await activeHost.delete(profileId)
    const entry = uiStore.getter(modelConnectionProfileEntryAtom)
    const profiles = entry.profiles.filter((profile) => profile.id !== profileId)
    setModelConnectionProfiles(uiStore, profiles)
    replaceOpenAiCompatConnections(profiles)
    closeModelConnectionProfileEditor(uiStore)
    setModelConnectionProfileState(uiStore, { status: 'saved' })
    synchronizeDefaultModelConnectionRuntime()
    return true
  } catch (error) {
    setModelConnectionProfileState(uiStore, { status: 'error', error: errorMessage(error) })
    return false
  }
}
