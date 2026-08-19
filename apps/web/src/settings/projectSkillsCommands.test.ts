import { uiStore } from '../uiStore'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disabledProjectSkillsByWorkspaceAtom, rootStore } from '@einfach-agent/core'
import { configureAppSettingsStorage } from './commands'
import {
  updateProjectSkillEnabled,
} from './projectSkillsCommands'
import { createMemoryAppSettingsStorage } from './persistence'
import { appSettingsAtom, resetAppSettingsState } from './state'
import { projectSkillsPreferenceStatusAtom } from './projectSkillsState'

describe('project skills settings commands', () => {
  beforeEach(() => {
    resetAppSettingsState(uiStore)
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(uiStore)
  })

  it('persists a workspace-local disable choice before publishing it to runtime state', () => {
    const storage = createMemoryAppSettingsStorage(uiStore.getter(appSettingsAtom))
    configureAppSettingsStorage(storage)

    expect(updateProjectSkillEnabled('workspace-1', 'project/release-check', false)).toBe(true)
    expect(storage.load().agent.disabledProjectSkills).toEqual({
      'workspace-1': ['project/release-check'],
    })
    expect(rootStore.getter(disabledProjectSkillsByWorkspaceAtom)).toEqual({
      'workspace-1': ['project/release-check'],
    })
    expect(uiStore.getter(projectSkillsPreferenceStatusAtom)).toEqual({ status: 'saved' })
  })

  it('keeps runtime preferences unchanged when persistence fails', () => {
    configureAppSettingsStorage({
      load: () => uiStore.getter(appSettingsAtom),
      save: () => { throw new Error('storage unavailable') },
    })

    expect(updateProjectSkillEnabled('workspace-1', 'project/release-check', false)).toBe(false)
    expect(rootStore.getter(disabledProjectSkillsByWorkspaceAtom)).toEqual({})
    expect(uiStore.getter(projectSkillsPreferenceStatusAtom)).toEqual({
      status: 'error', error: 'storage unavailable',
    })
  })
})
