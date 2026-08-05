import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { rootStore } from '@web-agent/core/state/rootStore'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
  deleteDeepSeekApiKey,
  deleteKimiApiKey,
  hydrateAppSettings,
  saveDeepSeekApiKey,
  saveKimiApiKey,
  updateDeepSeekApiKeyDraft,
  updateKimiApiKeyDraft,
} from './commands'
import {
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
  type ModelCredentialTarget,
} from './modelCredentialHost'
import { createMemoryAppSettingsStorage } from './persistence'
import {
  appSettingsAtom,
  customInstructionsStatusAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
  kimiApiKeyDraftAtom,
  kimiApiKeyStatusAtom,
  resetAppSettingsState,
} from './state'

function targetKey(target: ModelCredentialTarget): string {
  return `${target.provider}:${target.scope}`
}

function credentialHost(): {
  host: ModelCredentialHost
  saved: (target: ModelCredentialTarget) => string
} {
  const apiKeys = new Map<string, string>()
  const status = (target: ModelCredentialTarget) => ({
    configured: Boolean(apiKeys.get(targetKey(target))),
    source: apiKeys.get(targetKey(target)) ? 'keychain' as const : 'missing' as const,
  })
  return {
    host: {
      available: true,
      status: async (target) => status(target),
      save: async (target, value) => {
        apiKeys.set(targetKey(target), value)
        return status(target)
      },
      delete: async (target) => {
        apiKeys.delete(targetKey(target))
        return status(target)
      },
    },
    saved: (target) => apiKeys.get(targetKey(target)) ?? '',
  }
}

const DEEPSEEK_TARGET = { provider: 'deepseek', scope: 'default' } as const
const KIMI_CN_TARGET = { provider: 'kimi', scope: 'cn' } as const

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

  it('saves and deletes provider-scoped keys without persisting or exposing them', async () => {
    const fake = credentialHost()
    configureModelCredentialHost(fake.host)
    await hydrateAppSettings()
    updateDeepSeekApiKeyDraft('deepseek-test-key')
    updateKimiApiKeyDraft('kimi-test-key')

    await expect(saveDeepSeekApiKey()).resolves.toBe(true)
    await expect(saveKimiApiKey()).resolves.toBe(true)
    expect(fake.saved(DEEPSEEK_TARGET)).toBe('deepseek-test-key')
    expect(fake.saved(KIMI_CN_TARGET)).toBe('kimi-test-key')
    expect(rootStore.getter(deepSeekApiKeyDraftAtom)).toBe('')
    expect(rootStore.getter(kimiApiKeyDraftAtom)).toBe('')
    expect(rootStore.getter(deepSeekApiKeyStatusAtom)).toMatchObject({
      status: 'saved', configured: true, source: 'keychain',
    })
    expect(rootStore.getter(kimiApiKeyStatusAtom)).toMatchObject({
      status: 'saved', configured: true, source: 'keychain',
    })
    expect(JSON.stringify(rootStore.getter(appSettingsAtom))).not.toContain('test-key')

    await expect(deleteDeepSeekApiKey()).resolves.toBe(true)
    await expect(deleteKimiApiKey()).resolves.toBe(true)
    expect(fake.saved(DEEPSEEK_TARGET)).toBe('')
    expect(fake.saved(KIMI_CN_TARGET)).toBe('')
    expect(rootStore.getter(deepSeekApiKeyStatusAtom)).toMatchObject({ configured: false })
    expect(rootStore.getter(kimiApiKeyStatusAtom)).toMatchObject({ configured: false })
  })
})
