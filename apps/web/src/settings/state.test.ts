import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  INSTALLATION_ID_RANDOM_BYTES,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
} from './config'
import {
  appSettingsAtom,
  customInstructionsAtom,
  customInstructionsDirtyAtom,
  customInstructionsDraftAtom,
  deepSeekApiKeyDirtyAtom,
  deepSeekApiKeyDraftAtom,
} from './state'

const TEST_INSTALLATION_ID = `wa_${'a'.repeat(INSTALLATION_ID_RANDOM_BYTES * 2)}`

describe('app settings state', () => {
  it('projects custom instructions from the root settings atom', () => {
    const store = createStore()
    store.setter(appSettingsAtom, {
      version: 2,
      installationId: TEST_INSTALLATION_ID,
      agent: { customInstructions: '请始终使用中文回复' },
    })

    expect(store.getter(customInstructionsAtom)).toBe('请始终使用中文回复')
  })

  it('writes custom instructions back into the non-secret settings atom', () => {
    const store = createStore()
    const installationId = store.getter(appSettingsAtom).installationId
    store.setter(customInstructionsAtom, '优先给出结论')

    expect(store.getter(appSettingsAtom)).toEqual({
      version: 2,
      installationId,
      agent: { customInstructions: '优先给出结论' },
    })
  })

  it('bounds drafts without adding credentials to persistent state', () => {
    const store = createStore()
    store.setter(customInstructionsAtom, '字'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 10))
    store.setter(customInstructionsDraftAtom, '尚未保存')
    store.setter(deepSeekApiKeyDraftAtom, 'k'.repeat(MAX_MODEL_API_KEY_LENGTH + 10))

    expect(store.getter(customInstructionsAtom)).toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH)
    expect(store.getter(customInstructionsDirtyAtom)).toBe(true)
    expect(store.getter(deepSeekApiKeyDraftAtom)).toHaveLength(MAX_MODEL_API_KEY_LENGTH)
    expect(store.getter(deepSeekApiKeyDirtyAtom)).toBe(true)
    expect(JSON.stringify(store.getter(appSettingsAtom))).not.toContain('kkkk')
  })
})
