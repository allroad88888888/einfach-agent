import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCore } from '@einfach-agent/core'
import { uiStore } from '../uiStore'
import { openAiCompatConnection, replaceOpenAiCompatConnections } from '../modelTransport/openAiCompatRegistry'
import {
  addManualModelConnectionProfileModel, configureModelConnectionProfileHost,
  deleteModelConnectionProfile, hydrateModelConnectionProfiles, openCreateModelConnectionProfileEditor,
  openEditModelConnectionProfileEditor, probeModelConnectionProfile,
  removeModelConnectionProfileModel, replaceModelConnectionProfileModels,
  resetModelConnectionProfileEditor, saveModelConnectionProfile, updateModelConnectionProfileDraft,
} from './modelConnectionProfileCommands'
import {
  createUnavailableModelConnectionProfileHost, type ConnectionProfileModel, type ModelConnectionProfile,
  type ModelConnectionProfileHost, type ModelConnectionProfileSaveInput,
} from './modelConnectionProfileHost'
import {
  modelConnectionProfileDirtyAtom, modelConnectionProfileEditorModeAtom,
  modelConnectionProfileEntryAtom, modelConnectionProfileProbeStateAtom,
  modelConnectionProfileValidAtom, resetModelConnectionProfileState,
} from './modelConnectionProfileState'
import { closeSettingsCenter, configureAppSettingsStorage, setDefaultModelConnection } from './commands'
import { createMemoryAppSettingsStorage } from './persistence'
import { appSettingsAtom, resetAppSettingsState } from './state'

const MODELS: readonly ConnectionProfileModel[] = [
  { id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'discovered' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', source: 'discovered' },
]
const PROFILE: ModelConnectionProfile = {
  id: 'gateway-a', label: 'Gateway A', kind: 'openai-compatible',
  baseUrl: 'https://gateway.example.com/v1', models: MODELS, credentialConfigured: true,
}

function entry() { return uiStore.getter(modelConnectionProfileEntryAtom) }
function draft(models = MODELS, apiKey = '') {
  return { id: 'gateway-b', label: 'Gateway B', baseUrl: 'https://b.example.com/v1', models, apiKey }
}
function pendingProbe(): { promise: Promise<{ models: typeof MODELS }>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<{ models: typeof MODELS }>((done) => { resolve = () => done({ models: MODELS }) })
  return { promise, resolve }
}
function recordingHost(): { host: ModelConnectionProfileHost; saved: () => ModelConnectionProfileSaveInput | undefined } {
  let profiles: ModelConnectionProfile[] = [PROFILE]
  let lastSaved: ModelConnectionProfileSaveInput | undefined
  return { host: {
    available: true, list: async () => profiles,
    read: async (id) => profiles.find((profile) => profile.id === id) ?? null,
    save: async (input) => {
      lastSaved = input
      const { apiKey: _apiKey, ...publicInput } = input
      const profile = { ...publicInput, kind: 'openai-compatible' as const,
        credentialConfigured: Boolean(input.apiKey) || profiles.some((item) => item.id === input.id && item.credentialConfigured) }
      profiles = [...profiles.filter((item) => item.id !== input.id), profile]
      return profile
    },
    delete: async (id) => {
      const deleted = profiles.some((profile) => profile.id === id)
      profiles = profiles.filter((profile) => profile.id !== id)
      return { deleted }
    },
    probe: async () => ({ models: MODELS }),
  }, saved: () => lastSaved }
}

beforeEach(() => {
  resetAppSettingsState(uiStore); resetModelConnectionProfileState(uiStore)
  replaceOpenAiCompatConnections([]); configureAppSettingsStorage(createMemoryAppSettingsStorage())
  defaultCore.config.defaultModelSettings = undefined
})
afterEach(() => {
  configureModelConnectionProfileHost(createUnavailableModelConnectionProfileHost())
  replaceOpenAiCompatConnections([]); defaultCore.config.defaultModelSettings = undefined
})

describe('model connection profile commands', () => {
  it('hydrates public multi-model metadata and keeps transport metadata-only', async () => {
    const { host } = recordingHost(); configureModelConnectionProfileHost(host)
    await hydrateModelConnectionProfiles()
    expect(entry()).toMatchObject({ profiles: [PROFILE], state: { status: 'ready' } })
    expect(openAiCompatConnection(PROFILE.id)).toEqual({ id: PROFILE.id, kind: PROFILE.kind, baseUrl: PROFILE.baseUrl })
  })

  it('probes with the temporary key without replacing selected models', async () => {
    let input: { baseUrl: string; apiKey?: string } | undefined
    const { host } = recordingHost()
    configureModelConnectionProfileHost({ ...host, probe: async (value) => {
      input = value; return { models: [{ id: 'found', label: 'Found', source: 'discovered' }] }
    } })
    updateModelConnectionProfileDraft(draft([{ id: 'kept', label: 'Kept', source: 'manual' }], ' probe-key '))
    expect(await probeModelConnectionProfile()).toBe(true)
    expect(input).toEqual({ baseUrl: 'https://b.example.com/v1', apiKey: 'probe-key' })
    expect(entry().draft.models).toEqual([{ id: 'kept', label: 'Kept', source: 'manual' }])
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'ready', models: [{ id: 'found', label: 'Found', source: 'discovered' }] })
  })

  it('reports a probe failure without leaking its write-only key', async () => {
    const { host } = recordingHost()
    configureModelConnectionProfileHost({ ...host, probe: async () => { throw new Error('探测失败') } })
    updateModelConnectionProfileDraft(draft(MODELS, 'probe-key'))
    expect(await probeModelConnectionProfile()).toBe(false)
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'error', error: '探测失败' })
    expect(JSON.stringify(entry().probe)).not.toContain('probe-key')
  })

  it('clears probe context when switching or closing editors', async () => {
    const { host } = recordingHost(); configureModelConnectionProfileHost(host)
    await hydrateModelConnectionProfiles()
    updateModelConnectionProfileDraft(draft())
    await probeModelConnectionProfile()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom).status).toBe('ready')
    openCreateModelConnectionProfileEditor()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
    await probeModelConnectionProfile()
    expect(openEditModelConnectionProfileEditor(PROFILE.id)).toBe(true)
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
    await probeModelConnectionProfile()
    resetModelConnectionProfileEditor()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
  })

  it('clears probe context only when the trimmed base URL changes', async () => {
    const { host } = recordingHost(); configureModelConnectionProfileHost(host)
    updateModelConnectionProfileDraft(draft())
    await probeModelConnectionProfile()
    updateModelConnectionProfileDraft({ label: 'Renamed', id: 'gateway-c', models: MODELS, apiKey: 'temporary' })
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom).status).toBe('ready')
    updateModelConnectionProfileDraft({ baseUrl: ' https://b.example.com/v1 ' })
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom).status).toBe('ready')
    updateModelConnectionProfileDraft({ baseUrl: 'https://other.example.com/v1' })
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
  })

  it('silently drops pending probe results after its base URL changes', async () => {
    const pending = pendingProbe()
    const { host } = recordingHost(); configureModelConnectionProfileHost({ ...host, probe: async () => pending.promise })
    updateModelConnectionProfileDraft(draft())
    const result = probeModelConnectionProfile()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'loading' })
    updateModelConnectionProfileDraft({ baseUrl: 'https://other.example.com/v1' })
    pending.resolve()
    expect(await result).toBe(false)
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
  })

  it('silently drops pending probe results after switching editors', async () => {
    const pending = pendingProbe()
    const { host } = recordingHost(); configureModelConnectionProfileHost({ ...host, probe: async () => pending.promise })
    updateModelConnectionProfileDraft(draft())
    const result = probeModelConnectionProfile()
    openCreateModelConnectionProfileEditor()
    pending.resolve()
    expect(await result).toBe(false)
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
  })

  it('adds, de-duplicates, removes, and replaces manual draft models', () => {
    addManualModelConnectionProfileModel(' one '); addManualModelConnectionProfileModel('one')
    expect(entry().draft.models).toEqual([{ id: 'one', label: 'one', source: 'manual' }])
    replaceModelConnectionProfileModels(MODELS); removeModelConnectionProfileModel('deepseek-chat')
    expect(entry().draft.models).toEqual([MODELS[1]])
  })

  it('requires a model, writes its password only to save, and clears it after success', async () => {
    const { host, saved } = recordingHost(); configureModelConnectionProfileHost(host)
    updateModelConnectionProfileDraft(draft([], 'api-key-write-only'))
    expect(uiStore.getter(modelConnectionProfileValidAtom)).toBe(false)
    expect(await saveModelConnectionProfile()).toBe(false)
    updateModelConnectionProfileDraft({ models: [{ id: '   ', label: 'Blank', source: 'manual' }] })
    expect(uiStore.getter(modelConnectionProfileValidAtom)).toBe(false)
    expect(await saveModelConnectionProfile()).toBe(false)
    expect(saved()).toBeUndefined()
    updateModelConnectionProfileDraft({ models: MODELS })
    expect(uiStore.getter(modelConnectionProfileValidAtom)).toBe(true)
    expect(uiStore.getter(modelConnectionProfileDirtyAtom)).toBe(true)
    await probeModelConnectionProfile()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom).status).toBe('ready')
    expect(await saveModelConnectionProfile()).toBe(true)
    expect(saved()).toEqual({ ...draft(MODELS), apiKey: 'api-key-write-only' })
    expect(entry().draft).toEqual({ id: '', label: '', baseUrl: '', models: [], apiKey: '' })
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
    expect(JSON.stringify(entry())).not.toContain('api-key-write-only')
  })

  it('retains a failed save password only until the editor is abandoned', async () => {
    const { host } = recordingHost()
    configureModelConnectionProfileHost({ ...host, save: async () => { throw new Error('保存失败') } })
    openCreateModelConnectionProfileEditor(); updateModelConnectionProfileDraft(draft(MODELS, 'retry-key'))
    expect(await saveModelConnectionProfile()).toBe(false)
    expect(entry().draft.apiKey).toBe('retry-key')
    closeSettingsCenter()
    expect(entry().draft).toEqual({ id: '', label: '', baseUrl: '', models: [], apiKey: '' })
  })

  it('copies all models into edits and clears the password on cancel and deletion', async () => {
    const { host } = recordingHost(); configureModelConnectionProfileHost(host)
    await hydrateModelConnectionProfiles(); updateModelConnectionProfileDraft({ apiKey: 'old-key' })
    expect(openEditModelConnectionProfileEditor(PROFILE.id)).toBe(true)
    expect(entry().draft).toEqual({ id: PROFILE.id, label: PROFILE.label, baseUrl: PROFILE.baseUrl, models: MODELS, apiKey: '' })
    resetModelConnectionProfileEditor(); updateModelConnectionProfileDraft(draft(MODELS, 'delete-key'))
    await probeModelConnectionProfile()
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom).status).toBe('ready')
    expect(await deleteModelConnectionProfile(PROFILE.id)).toBe(true)
    expect(uiStore.getter(modelConnectionProfileEditorModeAtom)).toBe('closed')
    expect(entry().draft.apiKey).toBe('')
    expect(uiStore.getter(modelConnectionProfileProbeStateAtom)).toEqual({ status: 'idle' })
  })

  it('falls back if the selected model is removed without changing the preference', async () => {
    const { host } = recordingHost(); configureModelConnectionProfileHost(host)
    await hydrateModelConnectionProfiles(); setDefaultModelConnection({ id: PROFILE.id, model: MODELS[1].id })
    expect(defaultCore.config.defaultModelSettings).toMatchObject({ model: MODELS[1].id })
    expect(openEditModelConnectionProfileEditor(PROFILE.id)).toBe(true)
    updateModelConnectionProfileDraft({ models: [MODELS[0]] })
    expect(await saveModelConnectionProfile()).toBe(true)
    expect(defaultCore.config.defaultModelSettings).toBeUndefined()
    expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toEqual({ id: PROFILE.id, model: MODELS[1].id })
  })
})
