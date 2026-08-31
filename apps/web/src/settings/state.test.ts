import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_VERSION,
  INSTALLATION_ID_RANDOM_BYTES,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
} from './config'
import {
  appSettingsAtom,
  customInstructionsAtom,
  customInstructionsDirtyAtom,
  customInstructionsDraftAtom,
  defaultModelConnectionAtom,
  modelCredentialAtoms,
} from './state'

const deepSeekCredential = modelCredentialAtoms('deepseek-default')
const kimiCredential = modelCredentialAtoms('kimi-cn')

const TEST_INSTALLATION_ID = `wa_${'a'.repeat(INSTALLATION_ID_RANDOM_BYTES * 2)}`

describe('app settings state', () => {
  it('projects custom instructions from the root settings atom', () => {
    const store = createStore()
    store.setter(appSettingsAtom, {
      version: APP_SETTINGS_VERSION,
      installationId: TEST_INSTALLATION_ID,
      agent: { customInstructions: '请始终使用中文回复', disabledProjectSkills: {} },
    })

    expect(store.getter(customInstructionsAtom)).toBe('请始终使用中文回复')
  })

  it('writes custom instructions back into the non-secret settings atom', () => {
    const store = createStore()
    const installationId = store.getter(appSettingsAtom).installationId
    store.setter(customInstructionsAtom, '优先给出结论')

    expect(store.getter(appSettingsAtom)).toEqual({
      version: APP_SETTINGS_VERSION,
      installationId,
      agent: { customInstructions: '优先给出结论', disabledProjectSkills: {} },
    })
  })

  it('projects the persisted default third-party connection', () => {
    const store = createStore()
    const settings = store.getter(appSettingsAtom)
    store.setter(appSettingsAtom, {
      ...settings,
      defaultModelConnection: { id: 'gateway-a', model: 'deepseek-chat' },
    })

    expect(store.getter(defaultModelConnectionAtom)).toEqual({
      id: 'gateway-a', model: 'deepseek-chat',
    })
  })

  it('bounds drafts without adding credentials to persistent state', () => {
    const store = createStore()
    store.setter(customInstructionsAtom, '字'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 10))
    store.setter(customInstructionsDraftAtom, '尚未保存')
    store.setter(deepSeekCredential.draft, 'k'.repeat(MAX_MODEL_API_KEY_LENGTH + 10))
    store.setter(kimiCredential.draft, 'm'.repeat(MAX_MODEL_API_KEY_LENGTH + 10))

    expect(store.getter(customInstructionsAtom)).toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH)
    expect(store.getter(customInstructionsDirtyAtom)).toBe(true)
    expect(store.getter(deepSeekCredential.draft)).toHaveLength(MAX_MODEL_API_KEY_LENGTH)
    expect(store.getter(deepSeekCredential.dirty)).toBe(true)
    expect(store.getter(kimiCredential.draft)).toHaveLength(MAX_MODEL_API_KEY_LENGTH)
    expect(store.getter(kimiCredential.dirty)).toBe(true)
    expect(JSON.stringify(store.getter(appSettingsAtom))).not.toContain('kkkk')
    expect(JSON.stringify(store.getter(appSettingsAtom))).not.toContain('mmmm')
  })
})
