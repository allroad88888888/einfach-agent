import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { rootStore } from '@web-agent/core/state/rootStore'
import { createDefaultAppSettings } from './config'
import {
  configureAppSettingsEnvironment,
  configureAppSettingsStorage,
  hydrateAppSettings,
  saveDeepSeekApiKey,
  updateDeepSeekApiKeyDraft,
} from './commands'
import { createMemoryAppSettingsStorage } from './persistence'
import {
  deepSeekApiKeyDraftAtom,
  resetAppSettingsState,
} from './state'

describe('app settings commands', () => {
  beforeEach(() => {
    resetAppSettingsState(rootStore)
    configureCommands({
      customInstructions: '',
      deepseekApiKey: '',
      deepseekUserId: undefined,
    })
    configureAppSettingsEnvironment({ deepseekApiKey: '' })
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(rootStore)
    configureCommands({
      customInstructions: '',
      deepseekApiKey: '',
      deepseekUserId: undefined,
    })
    configureAppSettingsEnvironment({ deepseekApiKey: '' })
  })

  it('hydrates a saved DeepSeek key over the environment fallback', () => {
    const settings = createDefaultAppSettings()
    settings.providers.deepseek.apiKey = 'saved-key'
    configureAppSettingsStorage(createMemoryAppSettingsStorage(settings))
    configureAppSettingsEnvironment({ deepseekApiKey: 'environment-key' })

    hydrateAppSettings()

    expect(rootStore.getter(deepSeekApiKeyDraftAtom)).toBe('saved-key')
    expect(defaultCore.config.deepseekApiKey).toBe('saved-key')
    expect(defaultCore.config.deepseekUserId).toBe(settings.installationId)
  })

  it('uses the environment key when the saved key is empty', () => {
    configureAppSettingsEnvironment({ deepseekApiKey: 'environment-key' })

    hydrateAppSettings()

    expect(rootStore.getter(deepSeekApiKeyDraftAtom)).toBe('')
    expect(defaultCore.config.deepseekApiKey).toBe('environment-key')
    expect(defaultCore.config.deepseekUserId).toMatch(/^wa_[a-f0-9]{48}$/)
  })

  it('falls back to the environment after clearing a saved key', () => {
    const settings = createDefaultAppSettings()
    settings.providers.deepseek.apiKey = 'saved-key'
    const storage = createMemoryAppSettingsStorage(settings)
    configureAppSettingsStorage(storage)
    configureAppSettingsEnvironment({ deepseekApiKey: 'environment-key' })
    hydrateAppSettings()

    updateDeepSeekApiKeyDraft('')

    expect(saveDeepSeekApiKey()).toBe(true)
    expect(storage.load().providers.deepseek.apiKey).toBe('')
    expect(defaultCore.config.deepseekApiKey).toBe('environment-key')
  })
})
