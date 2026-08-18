import { uiStore } from '../uiStore'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCommands, defaultCore, rootStore } from '@web-agent/core'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
  deleteDeepSeekApiKey,
  deleteKimiApiKey,
  hydrateAppSettings,
  hydrateModelCredentials,
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
  modelCredentialAtoms,
  modelCredentialEntriesAtom,
  resetAppSettingsState,
} from './state'

const deepSeekCredential = modelCredentialAtoms('deepseek-default')
const kimiCredential = modelCredentialAtoms('kimi-cn')

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
    source: apiKeys.get(targetKey(target)) ? 'config' as const : 'missing' as const,
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
    resetAppSettingsState(uiStore)
    configureCommands({
      customInstructions: '',
      modelCredentials: { deepseek: 'desktop-managed-credential' },
    })
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(uiStore)
    configureModelCredentialHost(createUnavailableModelCredentialHost())
  })

  it('hydrates non-secret settings without overwriting the managed runtime marker', async () => {
    await hydrateAppSettings()

    expect(defaultCore.config.modelCredentials.deepseek).toBe('desktop-managed-credential')
    expect(defaultCore.config.modelUserId).toMatch(/^wa_[a-f0-9]{48}$/)
  })

  it('surfaces a storage migration failure to settings state', async () => {
    configureAppSettingsStorage({
      load: () => { throw new Error('无法安全清理旧版模型凭据，请清除应用网站数据后重试') },
      save: () => {},
    })

    await hydrateAppSettings()

    expect(uiStore.getter(customInstructionsStatusAtom)).toMatchObject({
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
    expect(uiStore.getter(deepSeekCredential.draft)).toBe('')
    expect(uiStore.getter(kimiCredential.draft)).toBe('')
    expect(uiStore.getter(deepSeekCredential.status)).toMatchObject({
      status: 'saved', configured: true, source: 'config',
    })
    expect(uiStore.getter(kimiCredential.status)).toMatchObject({
      status: 'saved', configured: true, source: 'config',
    })
    expect(JSON.stringify(uiStore.getter(appSettingsAtom))).not.toContain('test-key')

    await expect(deleteDeepSeekApiKey()).resolves.toBe(true)
    await expect(deleteKimiApiKey()).resolves.toBe(true)
    expect(fake.saved(DEEPSEEK_TARGET)).toBe('')
    expect(fake.saved(KIMI_CN_TARGET)).toBe('')
    expect(uiStore.getter(deepSeekCredential.status)).toMatchObject({ configured: false })
    expect(uiStore.getter(kimiCredential.status)).toMatchObject({ configured: false })
  })

  it('preserves the draft when the saved credential cannot be verified', async () => {
    configureModelCredentialHost({
      available: true,
      status: async () => ({ configured: false, source: 'missing' }),
      save: async () => ({ configured: true, source: 'config' }),
      delete: async () => ({ configured: false, source: 'missing' }),
    })
    updateDeepSeekApiKeyDraft('deepseek-unverified-key')

    await expect(saveDeepSeekApiKey()).resolves.toBe(false)

    expect(uiStore.getter(deepSeekCredential.draft)).toBe('deepseek-unverified-key')
    expect(uiStore.getter(deepSeekCredential.status)).toMatchObject({
      status: 'error',
      configured: false,
      source: 'missing',
      error: '未能确认 DeepSeek API Key 已保存，请重试。',
    })
  })

  it('preserves the draft and hides host errors when saving fails', async () => {
    let statusCalls = 0
    configureModelCredentialHost({
      available: true,
      status: async () => {
        statusCalls += 1
        return { configured: false, source: 'missing' }
      },
      save: async () => { throw new Error('save leaked deepseek-save-secret') },
      delete: async () => ({ configured: false, source: 'missing' }),
    })
    updateDeepSeekApiKeyDraft('deepseek-save-secret')

    await expect(saveDeepSeekApiKey()).resolves.toBe(false)

    const status = uiStore.getter(deepSeekCredential.status)
    expect(statusCalls).toBe(0)
    expect(uiStore.getter(deepSeekCredential.draft)).toBe('deepseek-save-secret')
    expect(status).toMatchObject({
      status: 'error',
      configured: false,
      source: 'missing',
      error: '未能确认 DeepSeek API Key 已保存，请重试。',
    })
    expect(JSON.stringify(status)).not.toContain('deepseek-save-secret')
  })

  it('preserves the draft and hides host errors when verification fails', async () => {
    let statusCalls = 0
    configureModelCredentialHost({
      available: true,
      status: async () => {
        statusCalls += 1
        throw new Error('status leaked deepseek-verification-secret')
      },
      save: async () => ({ configured: true, source: 'config' }),
      delete: async () => ({ configured: false, source: 'missing' }),
    })
    updateDeepSeekApiKeyDraft('deepseek-verification-secret')

    await expect(saveDeepSeekApiKey()).resolves.toBe(false)

    const status = uiStore.getter(deepSeekCredential.status)
    expect(statusCalls).toBe(1)
    expect(uiStore.getter(deepSeekCredential.draft)).toBe('deepseek-verification-secret')
    expect(status).toMatchObject({
      status: 'error',
      configured: false,
      source: 'missing',
      error: '未能确认 DeepSeek API Key 已保存，请重试。',
    })
    expect(JSON.stringify(status)).not.toContain('deepseek-verification-secret')
  })

  it('hides a credential status read error while retaining other credential results', async () => {
    configureModelCredentialHost({
      available: true,
      status: async (target) => {
        if (target.provider === 'deepseek') {
          throw new Error('status leaked deepseek-hydration-secret')
        }
        return {
          configured: true,
          source: 'config',
        }
      },
      save: async () => ({ configured: false, source: 'missing' }),
      delete: async () => ({ configured: false, source: 'missing' }),
    })

    await hydrateModelCredentials()

    const entries = uiStore.getter(modelCredentialEntriesAtom)
    expect(entries['deepseek-default'].state).toEqual({
      status: 'error',
      error: '无法读取 DeepSeek API Key 状态，请重试。',
      configured: false,
      source: 'missing',
    })
    expect(JSON.stringify(entries['deepseek-default'].state)).not.toContain(
      'deepseek-hydration-secret',
    )
    expect(entries['glm-default'].state).toEqual({
      status: 'ready',
      configured: true,
      source: 'config',
    })
    expect(entries['kimi-cn'].state).toEqual({
      status: 'ready',
      configured: true,
      source: 'config',
    })
  })
})
