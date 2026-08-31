import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uiStore } from '../uiStore'
import { closeSettingsCenter, openSettingsCenter } from './settingsCenterCommands'
import {
  modelConnectionProfileEntryAtom,
  modelConnectionProfileHostAvailableAtom,
  openCreateModelConnectionProfileEditor,
  resetModelConnectionProfileState,
  setModelConnectionProfileDraft,
  setModelConnectionProfiles,
} from './modelConnectionProfileState'
import { settingsCenterOpenAtom } from './settingsCenterState'

const PROFILE = {
  id: 'gateway-a',
  label: 'Gateway A',
  kind: 'openai-compatible' as const,
  baseUrl: 'https://gateway.example.com/v1',
  models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' as const }],
  credentialConfigured: true,
}

function openEditorWithPassword(): void {
  setModelConnectionProfiles(uiStore, [PROFILE])
  uiStore.setter(modelConnectionProfileHostAvailableAtom, true)
  openCreateModelConnectionProfileEditor(uiStore)
  setModelConnectionProfileDraft(uiStore, {
    id: 'gateway-b',
    label: 'Gateway B',
    baseUrl: 'https://gateway-b.example.com/v1',
    models: [{ id: 'deepseek-v3', label: 'DeepSeek V3', source: 'manual' }],
    apiKey: 'write-only-unsaved-key',
  })
  openSettingsCenter('model')
}

describe('closeSettingsCenter', () => {
  beforeEach(() => {
    resetModelConnectionProfileState(uiStore)
  })

  afterEach(() => {
    resetModelConnectionProfileState(uiStore)
  })

  it('closes and clears an abandoned model connection editor without clearing profiles', () => {
    openEditorWithPassword()

    closeSettingsCenter()

    expect(uiStore.getter(settingsCenterOpenAtom)).toBe(false)
    expect(uiStore.getter(modelConnectionProfileEntryAtom)).toEqual({
      profiles: [PROFILE],
      editorMode: 'closed',
      draft: { id: '', label: '', baseUrl: '', models: [], apiKey: '' },
      probe: { status: 'idle' },
      state: { status: 'idle' },
    })
    expect(uiStore.getter(modelConnectionProfileHostAvailableAtom)).toBe(true)
  })
})
