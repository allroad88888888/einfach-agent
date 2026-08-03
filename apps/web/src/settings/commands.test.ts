import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { rootStore } from '@web-agent/core/state/rootStore'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
  deleteDeepSeekApiKey,
  hydrateAppSettings,
  saveDeepSeekApiKey,
  updateDeepSeekApiKeyDraft,
} from './commands'
import {
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from './modelCredentialHost'
import { createMemoryAppSettingsStorage } from './persistence'
import {
  appSettingsAtom,
  customInstructionsStatusAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
  resetAppSettingsState,
} from './state'

function credentialHost(): { host: ModelCredentialHost; saved: () => string } {
  let apiKey = ''
  const status = () => ({
    configured: Boolean(apiKey),
    source: apiKey ? 'keychain' as const : 'missing' as const,
  })
  return {
    host: {
      deepSeekStatus: async () => status(),
      saveDeepSeek: async (value) => {
        apiKey = value
        return status()
      },
      deleteDeepSeek: async () => {
        apiKey = ''
        return status()
      },
    },
    saved: () => apiKey,
  }
}

describe('app settings commands', () => {
  beforeEach(() => {
    resetAppSettingsState(rootStore)
    configureCommands({ customInstructions: '', deepseekApiKey: 'desktop-managed-credential' })
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(rootStore)
    configureModelCredentialHost(createUnavailableModelCredentialHost())
  })

  it('hydrates non-secret settings without overwriting the managed runtime marker', async () => {
    await hydrateAppSettings()

    expect(defaultCore.config.deepseekApiKey).toBe('desktop-managed-credential')
    expect(defaultCore.config.deepseekUserId).toMatch(/^wa_[a-f0-9]{48}$/)
  })

  it('surfaces a storage migration failure to settings state', async () => {
    configureAppSettingsStorage({
      load: () => { throw new Error('无法安全清理旧版模型凭据，请清除应用网站数据后重试') },
      save: () => {},
    })

    await hydrateAppSettings()

    expect(rootStore.getter(customInstructionsStatusAtom)).toMatchObject({
      status: 'error',
      error: '无法安全清理旧版模型凭据，请清除应用网站数据后重试',
    })
  })

  it('saves and deletes a key through the host without persisting or exposing it in state', async () => {
    const fake = credentialHost()
    configureModelCredentialHost(fake.host)
    await hydrateAppSettings()
    updateDeepSeekApiKeyDraft('deepseek-test-key')

    await expect(saveDeepSeekApiKey()).resolves.toBe(true)
    expect(fake.saved()).toBe('deepseek-test-key')
    expect(rootStore.getter(deepSeekApiKeyDraftAtom)).toBe('')
    expect(rootStore.getter(deepSeekApiKeyStatusAtom)).toMatchObject({
      status: 'saved', configured: true, source: 'keychain',
    })
    expect(JSON.stringify(rootStore.getter(appSettingsAtom))).not.toContain('deepseek-test-key')

    await expect(deleteDeepSeekApiKey()).resolves.toBe(true)
    expect(fake.saved()).toBe('')
    expect(rootStore.getter(deepSeekApiKeyStatusAtom)).toMatchObject({ configured: false })
  })
})
