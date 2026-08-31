import { uiStore } from '../uiStore'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCore, newSession, sessionsAtom } from '@einfach-agent/core'
import {
  clearDefaultModelConnection,
  clearDefaultModelConnectionIfMatching,
  configureAppSettingsStorage,
  hydrateAppSettings,
  setDefaultModelConnection,
} from './commands'
import { createMemoryAppSettingsStorage } from './persistence'
import { appSettingsAtom, resetAppSettingsState } from './state'
import {
  modelConnectionProfileHostAvailableAtom,
  resetModelConnectionProfileState,
  setModelConnectionProfiles,
  setModelConnectionProfileState,
} from './modelConnectionProfileState'

const CONNECTION_SETTINGS = {
  vendor: 'openai-compat',
  model: 'deepseek-chat',
  vendorSettings: { connectionId: 'gateway-a' },
} as const

describe('default model connection commands', () => {
  beforeEach(() => {
    resetAppSettingsState(uiStore)
    resetModelConnectionProfileState(uiStore)
    defaultCore.config.defaultModelSettings = undefined
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
  })

  afterEach(() => {
    resetAppSettingsState(uiStore)
    resetModelConnectionProfileState(uiStore)
    defaultCore.config.defaultModelSettings = undefined
  })

  function verifyProfile(models = [{ id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' as const }]): void {
    uiStore.setter(modelConnectionProfileHostAvailableAtom, true)
    setModelConnectionProfiles(uiStore, [{
      id: 'gateway-a',
      label: 'Gateway A',
      kind: 'openai-compatible',
      baseUrl: 'https://gateway.example.com/v1',
      models,
      credentialConfigured: true,
    }])
    setModelConnectionProfileState(uiStore, { status: 'ready' })
  }

  it('hydrates a persisted connection as the default for future sessions only', async () => {
    verifyProfile()
    const storage = createMemoryAppSettingsStorage()
    const settings = storage.load()
    settings.defaultModelConnection = { id: 'gateway-a', model: 'deepseek-chat' }
    storage.save(settings)
    configureAppSettingsStorage(storage)
    const existing = newSession({
      settings: { vendor: 'deepseek', model: 'deepseek-chat' },
    })

    await hydrateAppSettings()
    const future = newSession()

    expect(defaultCore.config.defaultModelSettings).toEqual(CONNECTION_SETTINGS)
    expect(defaultCore.rootStore.getter(sessionsAtom)[existing]?.settings).toEqual({
      vendor: 'deepseek', model: 'deepseek-chat',
    })
    expect(defaultCore.rootStore.getter(sessionsAtom)[future]?.settings).toEqual(CONNECTION_SETTINGS)
  })

  it('sets, conditionally clears, and restores the built-in future-session default', () => {
    verifyProfile()
    setDefaultModelConnection({ id: 'gateway-a', model: 'deepseek-chat' })

    expect(defaultCore.config.defaultModelSettings).toEqual(CONNECTION_SETTINGS)
    expect(clearDefaultModelConnectionIfMatching('gateway-b')).toBe(false)
    expect(clearDefaultModelConnectionIfMatching('gateway-a')).toBe(true)
    expect(defaultCore.config.defaultModelSettings).toBeUndefined()

    setDefaultModelConnection({ id: 'gateway-a', model: 'deepseek-chat' })
    clearDefaultModelConnection()
    expect(defaultCore.config.defaultModelSettings).toBeUndefined()
  })

  it('keeps missing and static preferences persisted while runtime falls back safely', async () => {
    const storage = createMemoryAppSettingsStorage()
    const settings = storage.load()
    settings.defaultModelConnection = { id: 'missing-profile', model: 'stale-model' }
    storage.save(settings)
    configureAppSettingsStorage(storage)

    await hydrateAppSettings()

    expect(defaultCore.config.defaultModelSettings).toBeUndefined()
    expect(storage.load().defaultModelConnection).toEqual({
      id: 'missing-profile', model: 'stale-model',
    })

    verifyProfile()
    uiStore.setter(modelConnectionProfileHostAvailableAtom, false)
    setDefaultModelConnection({ id: 'gateway-a', model: 'deepseek-chat' })
    expect(defaultCore.config.defaultModelSettings).toBeUndefined()
    expect(storage.load().defaultModelConnection?.id).toBe('gateway-a')
  })

  it('falls back without changing a persisted preference for a missing profile model', () => {
    verifyProfile([{ id: 'available', label: 'Available', source: 'manual' }])
    setDefaultModelConnection({ id: 'gateway-a', model: 'removed' })
    expect(defaultCore.config.defaultModelSettings).toBeUndefined()
    expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toEqual({ id: 'gateway-a', model: 'removed' })
  })
})
