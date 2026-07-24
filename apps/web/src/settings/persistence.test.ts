import { describe, expect, it } from 'vitest'
import {
  INSTALLATION_ID_RANDOM_BYTES,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
  createInstallationId,
  createDefaultAppSettings,
  isInstallationId,
} from './config'
import {
  APP_SETTINGS_STORAGE_KEY,
  LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY,
  createAppSettingsStorage,
  createMemoryAppSettingsStorage,
} from './persistence'

const TEST_INSTALLATION_ID = `wa_${'a'.repeat(INSTALLATION_ID_RANDOM_BYTES * 2)}`
const SECOND_INSTALLATION_ID = `wa_${'b'.repeat(INSTALLATION_ID_RANDOM_BYTES * 2)}`

describe('app settings persistence', () => {
  it('generates a protocol-safe opaque id from random bytes only', () => {
    const installationId = createInstallationId((target) => target.fill(0xab))

    expect(installationId).toBe(`wa_${'ab'.repeat(INSTALLATION_ID_RANDOM_BYTES)}`)
    expect(isInstallationId(installationId)).toBe(true)
    expect(installationId).not.toContain('@')
    expect(installationId).not.toContain('/')
    expect(installationId.length).toBeLessThanOrEqual(512)
  })

  it('round-trips the versioned settings object', () => {
    const values = new Map<string, string>()
    const storage = createAppSettingsStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    })
    const settings = createDefaultAppSettings()
    settings.agent.customInstructions = '请始终使用中文回复'
    settings.providers.deepseek.apiKey = 'deepseek-test-key'

    storage.save(settings)

    expect(storage.load()).toEqual(settings)
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
      version: 1,
      installationId: settings.installationId,
      agent: {
        customInstructions: '请始终使用中文回复',
      },
      providers: {
        deepseek: {
          apiKey: 'deepseek-test-key',
        },
      },
    })
  })

  it('migrates the legacy custom-instructions envelope', () => {
    const values = new Map<string, string>([
      [
        LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          customInstructions: '优先给出结论',
        }),
      ],
    ])
    const storage = createAppSettingsStorage(
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      { createInstallationId: () => TEST_INSTALLATION_ID },
    )

    expect(storage.load()).toEqual({
      version: 1,
      installationId: TEST_INSTALLATION_ID,
      agent: {
        customInstructions: '优先给出结论',
      },
      providers: {
        deepseek: {
          apiKey: '',
        },
      },
    })
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
      version: 1,
      installationId: TEST_INSTALLATION_ID,
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

  it('adds provider defaults when reading an earlier v1 settings object', () => {
    const values = new Map<string, string>([
      [
        APP_SETTINGS_STORAGE_KEY,
        '{"version":1,"agent":{"customInstructions":"保持简洁"}}',
      ],
    ])
    const storage = createAppSettingsStorage(
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      { createInstallationId: () => TEST_INSTALLATION_ID },
    )

    expect(storage.load()).toEqual({
      version: 1,
      installationId: TEST_INSTALLATION_ID,
      agent: {
        customInstructions: '保持简洁',
      },
      providers: {
        deepseek: {
          apiKey: '',
        },
      },
    })
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      installationId: TEST_INSTALLATION_ID,
    })
  })

  it('still reads legacy settings when migration write-back is unavailable', () => {
    const storage = createAppSettingsStorage(
      {
        getItem: (key) => key === LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY
          ? '{"version":1,"customInstructions":"使用中文"}'
          : null,
        setItem: () => {
          throw new Error('read only')
        },
      },
      { createInstallationId: () => TEST_INSTALLATION_ID },
    )

    expect(storage.load().agent.customInstructions).toBe('使用中文')
  })

  it('keeps one installation id in memory when storage is readable but not writable', () => {
    let generated = 0
    const storage = createAppSettingsStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('read only')
        },
      },
      {
        createInstallationId: () => {
          generated += 1
          return generated === 1 ? TEST_INSTALLATION_ID : SECOND_INSTALLATION_ID
        },
      },
    )

    expect(storage.load().installationId).toBe(TEST_INSTALLATION_ID)
    expect(storage.load().installationId).toBe(TEST_INSTALLATION_ID)
    expect(generated).toBe(1)
  })

  it('keeps one installation id in memory when storage reads are unavailable', () => {
    let generated = 0
    const storage = createAppSettingsStorage(
      {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      },
      {
        createInstallationId: () => {
          generated += 1
          return generated === 1 ? TEST_INSTALLATION_ID : SECOND_INSTALLATION_ID
        },
      },
    )

    expect(storage.load().installationId).toBe(TEST_INSTALLATION_ID)
    expect(storage.load().installationId).toBe(TEST_INSTALLATION_ID)
    expect(generated).toBe(1)
  })

  it('persists a fresh id immediately and reuses it across storage instances', () => {
    const values = new Map<string, string>()
    let generated = 0
    const storageLike = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const firstStorage = createAppSettingsStorage(storageLike, {
      createInstallationId: () => {
        generated += 1
        return TEST_INSTALLATION_ID
      },
    })
    const first = firstStorage.load()
    const secondStorage = createAppSettingsStorage(storageLike, {
      createInstallationId: () => {
        generated += 1
        return SECOND_INSTALLATION_ID
      },
    })

    expect(first.installationId).toBe(TEST_INSTALLATION_ID)
    expect(secondStorage.load().installationId).toBe(TEST_INSTALLATION_ID)
    expect(generated).toBe(1)
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      installationId: TEST_INSTALLATION_ID,
    })
  })

  it.each([
    'person@example.com',
    '/Users/person/project',
    'Alice',
    '',
  ])('repairs privacy-unsafe or invalid persisted id %j and writes it back', (invalidId) => {
    const values = new Map<string, string>([
      [
        APP_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          installationId: invalidId,
          agent: { customInstructions: '' },
          providers: { deepseek: { apiKey: '' } },
        }),
      ],
    ])
    const storage = createAppSettingsStorage(
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
      { createInstallationId: () => SECOND_INSTALLATION_ID },
    )

    expect(storage.load().installationId).toBe(SECOND_INSTALLATION_ID)
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      installationId: SECOND_INSTALLATION_ID,
    })
  })

  it('rejects malformed persisted data', () => {
    const storage = createAppSettingsStorage({
      getItem: (key) => key === APP_SETTINGS_STORAGE_KEY
        ? '{"version":1,"agent":{"customInstructions":42}}'
        : null,
      setItem: () => {},
    })

    expect(() => storage.load()).toThrow('应用设置格式无效')
  })

  it('bounds settings values in memory storage', () => {
    const settings = createDefaultAppSettings()
    settings.agent.customInstructions = '字'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 10)
    settings.providers.deepseek.apiKey = 'k'.repeat(MAX_MODEL_API_KEY_LENGTH + 10)
    const storage = createMemoryAppSettingsStorage(settings)

    expect(storage.load().agent.customInstructions)
      .toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH)
    expect(storage.load().providers.deepseek.apiKey)
      .toHaveLength(MAX_MODEL_API_KEY_LENGTH)
  })

  it('returns independent snapshots from memory storage', () => {
    const storage = createMemoryAppSettingsStorage()
    const initial = storage.load()
    const loaded = storage.load()
    loaded.agent.customInstructions = '只修改调用方副本'
    loaded.providers.deepseek.apiKey = '只修改调用方副本'

    expect(storage.load()).toEqual(initial)
  })
})
