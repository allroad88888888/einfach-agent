import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  disabledProjectSkillsByWorkspaceAtom,
  rootStore,
} from '@web-agent/core/state/rootStore'
import { configureAppSettingsStorage } from './commands'
import {
  updateProjectSkillEnabled,
} from './projectSkillsCommands'
import { createMemoryAppSettingsStorage } from './persistence'
import { appSettingsAtom, resetAppSettingsState } from './state'
import { projectSkillsPreferenceStatusAtom } from './projectSkillsState'

describe('project skills settings commands', () => {
  beforeEach(() => {
    resetAppSettingsState(rootStore)
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(rootStore)
  })

  it('persists a workspace-local disable choice before publishing it to runtime state', () => {
    const storage = createMemoryAppSettingsStorage(rootStore.getter(appSettingsAtom))
    configureAppSettingsStorage(storage)

    expect(updateProjectSkillEnabled('workspace-1', 'project/release-check', false)).toBe(true)
    expect(storage.load().agent.disabledProjectSkills).toEqual({
      'workspace-1': ['project/release-check'],
    })
    expect(rootStore.getter(disabledProjectSkillsByWorkspaceAtom)).toEqual({
      'workspace-1': ['project/release-check'],
    })
    expect(rootStore.getter(projectSkillsPreferenceStatusAtom)).toEqual({ status: 'saved' })
  })

  it('keeps runtime preferences unchanged when persistence fails', () => {
    configureAppSettingsStorage({
      load: () => rootStore.getter(appSettingsAtom),
      save: () => { throw new Error('storage unavailable') },
    })

    expect(updateProjectSkillEnabled('workspace-1', 'project/release-check', false)).toBe(false)
    expect(rootStore.getter(disabledProjectSkillsByWorkspaceAtom)).toEqual({})
    expect(rootStore.getter(projectSkillsPreferenceStatusAtom)).toEqual({
      status: 'error', error: 'storage unavailable',
    })
  })
})
