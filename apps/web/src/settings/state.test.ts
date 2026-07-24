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
  deepSeekApiKeyAtom,
  deepSeekApiKeyDirtyAtom,
  deepSeekApiKeyDraftAtom,
} from './state'

const TEST_INSTALLATION_ID = `wa_${'a'.repeat(INSTALLATION_ID_RANDOM_BYTES * 2)}`

describe('app settings state', () => {
  it('projects custom instructions from the root settings atom', () => {
    const store = createStore()

    store.setter(appSettingsAtom, {
      version: 1,
      installationId: TEST_INSTALLATION_ID,
      agent: {
        customInstructions: '请始终使用中文回复',
      },
      providers: {
        deepseek: {
          apiKey: 'deepseek-key',
        },
      },
    })

    expect(store.getter(customInstructionsAtom)).toBe('请始终使用中文回复')
    expect(store.getter(deepSeekApiKeyAtom)).toBe('deepseek-key')
  })

  it('writes a field atom back into the root settings atom', () => {
    const store = createStore()
    const installationId = store.getter(appSettingsAtom).installationId

    store.setter(customInstructionsAtom, '优先给出结论')

    expect(store.getter(appSettingsAtom)).toEqual({
      version: 1,
      installationId,
      agent: {
        customInstructions: '优先给出结论',
      },
      providers: {
        deepseek: {
          apiKey: '',
        },
      },
    })
  })

  it('bounds field writes and derives dirty state without duplicating it', () => {
    const store = createStore()
    store.setter(customInstructionsAtom, '字'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 10))
    store.setter(customInstructionsDraftAtom, '尚未保存')

    expect(store.getter(customInstructionsAtom))
      .toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH)
    expect(store.getter(customInstructionsDirtyAtom)).toBe(true)
  })

  it('writes and bounds the DeepSeek key through the root settings atom', () => {
    const store = createStore()
    store.setter(deepSeekApiKeyAtom, 'k'.repeat(MAX_MODEL_API_KEY_LENGTH + 10))
    store.setter(deepSeekApiKeyDraftAtom, 'draft-key')

    expect(store.getter(deepSeekApiKeyAtom)).toHaveLength(MAX_MODEL_API_KEY_LENGTH)
    expect(store.getter(appSettingsAtom).providers.deepseek.apiKey)
      .toHaveLength(MAX_MODEL_API_KEY_LENGTH)
    expect(store.getter(deepSeekApiKeyDirtyAtom)).toBe(true)
  })
})
