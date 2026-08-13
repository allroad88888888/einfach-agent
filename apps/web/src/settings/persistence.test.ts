import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_VERSION,
  INSTALLATION_ID_RANDOM_BYTES,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  createDefaultAppSettings,
  createInstallationId,
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

function mapStorage(values = new Map<string, string>()) {
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  }
}

describe('app settings persistence', () => {
  it('generates a protocol-safe opaque id from random bytes only', () => {
    const installationId = createInstallationId((target) => target.fill(0xab))

    expect(installationId).toBe(`wa_${'ab'.repeat(INSTALLATION_ID_RANDOM_BYTES)}`)
    expect(isInstallationId(installationId)).toBe(true)
    expect(installationId).not.toContain('@')
    expect(installationId).not.toContain('/')
  })

  it('round-trips only non-secret versioned settings', () => {
    const { values, storage: storageLike } = mapStorage()
    const storage = createAppSettingsStorage(storageLike)
    const settings = createDefaultAppSettings()
    settings.agent.customInstructions = '请始终使用中文回复'

    storage.save(settings)

    expect(storage.load()).toEqual(settings)
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toEqual({
      version: APP_SETTINGS_VERSION,
      installationId: settings.installationId,
      agent: { customInstructions: '请始终使用中文回复', disabledProjectSkills: {} },
    })
  })

  it('migrates a v1 credential in place and removes it from local storage', () => {
    const legacyCredential = 'legacy-deepseek-key-that-must-disappear'
    const { values, storage: storageLike } = mapStorage(new Map([
      [
        APP_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          installationId: TEST_INSTALLATION_ID,
          agent: { customInstructions: '保持简洁' },
          providers: { deepseek: { apiKey: legacyCredential } },
        }),
      ],
    ]))
    const storage = createAppSettingsStorage(storageLike)

    expect(storage.load()).toEqual({
      version: APP_SETTINGS_VERSION,
      installationId: TEST_INSTALLATION_ID,
      agent: { customInstructions: '保持简洁', disabledProjectSkills: {} },
    })
    const rewritten = values.get(APP_SETTINGS_STORAGE_KEY)!
    expect(rewritten).not.toContain(legacyCredential)
    expect(rewritten).not.toContain('apiKey')
  })

  it('rewrites a credential-free v1 envelope to the current version', () => {
    const { values, storage: storageLike } = mapStorage(new Map([[
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        installationId: TEST_INSTALLATION_ID,
        agent: { customInstructions: '保持简洁' },
      }),
    ]]))
    const storage = createAppSettingsStorage(storageLike)

    storage.load()

    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      version: APP_SETTINGS_VERSION,
      installationId: TEST_INSTALLATION_ID,
    })
  })

  it('migrates v2 settings by adding an empty disabled project skills map', () => {
    const { values, storage: storageLike } = mapStorage(new Map([[
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        installationId: TEST_INSTALLATION_ID,
        agent: { customInstructions: '保持简洁' },
      }),
    ]]))
    const storage = createAppSettingsStorage(storageLike)

    expect(storage.load()).toEqual({
      version: APP_SETTINGS_VERSION,
      installationId: TEST_INSTALLATION_ID,
      agent: { customInstructions: '保持简洁', disabledProjectSkills: {} },
    })
    expect(JSON.parse(values.get(APP_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      version: APP_SETTINGS_VERSION,
      agent: { disabledProjectSkills: {} },
    })
  })

  it('removes a legacy credential when its sanitized rewrite is blocked', () => {
    const legacyCredential = 'legacy-deepseek-key-that-must-disappear'
    const values = new Map([[
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        installationId: TEST_INSTALLATION_ID,
        agent: { customInstructions: '保持简洁' },
        providers: { deepseek: { apiKey: legacyCredential } },
      }),
    ]])
    const storage = createAppSettingsStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: () => { throw new Error('writes blocked') },
      removeItem: (key) => values.delete(key),
    })

    expect(storage.load().agent.customInstructions).toBe('保持简洁')
    expect(values.get(APP_SETTINGS_STORAGE_KEY)).toBeUndefined()
  })

  it('reports failure when a legacy credential cannot be cleared', () => {
    const legacyCredential = 'legacy-deepseek-key-that-must-disappear'
    const storage = createAppSettingsStorage({
      getItem: () => JSON.stringify({
        version: 1,
        installationId: TEST_INSTALLATION_ID,
        agent: { customInstructions: '保持简洁' },
        providers: { deepseek: { apiKey: legacyCredential } },
      }),
      setItem: () => { throw new Error('writes blocked') },
      removeItem: () => { throw new Error('removal blocked') },
    })

    expect(() => storage.load()).toThrow('无法安全清理旧版模型凭据')
  })

  it('migrates the legacy custom-instructions envelope without adding a credential field', () => {
    const { values, storage: storageLike } = mapStorage(new Map([
      [
        LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY,
        JSON.stringify({ version: 1, customInstructions: '优先给出结论' }),
      ],
    ]))
    const storage = createAppSettingsStorage(storageLike, {
      createInstallationId: () => TEST_INSTALLATION_ID,
    })

    expect(storage.load()).toEqual({
      version: APP_SETTINGS_VERSION,
      installationId: TEST_INSTALLATION_ID,
      agent: { customInstructions: '优先给出结论', disabledProjectSkills: {} },
    })
    expect(values.get(APP_SETTINGS_STORAGE_KEY)).not.toContain('apiKey')
  })

  it.each(['person@example.com', '/Users/person/project', 'Alice', ''])
  ('repairs an unsafe installation id while retaining no old credential', (invalidId) => {
    const { values, storage: storageLike } = mapStorage(new Map([
      [
        APP_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          installationId: invalidId,
          agent: { customInstructions: '' },
          providers: { deepseek: { apiKey: 'remove-this' } },
        }),
      ],
    ]))
    const storage = createAppSettingsStorage(storageLike, {
      createInstallationId: () => SECOND_INSTALLATION_ID,
    })

    expect(storage.load().installationId).toBe(SECOND_INSTALLATION_ID)
    expect(values.get(APP_SETTINGS_STORAGE_KEY)).not.toContain('remove-this')
  })

  it('uses one volatile id when browser storage is blocked', () => {
    let generated = 0
    const storage = createAppSettingsStorage(
      {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
        removeItem: () => {
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

  it('bounds non-secret settings and returns independent memory snapshots', () => {
    const settings = createDefaultAppSettings()
    settings.agent.customInstructions = '字'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 10)
    const storage = createMemoryAppSettingsStorage(settings)
    const loaded = storage.load()
    loaded.agent.customInstructions = '只修改调用方副本'
    loaded.agent.disabledProjectSkills['workspace-1'] = ['project/release-check']

    expect(storage.load().agent.customInstructions).toHaveLength(MAX_CUSTOM_INSTRUCTIONS_LENGTH)
    expect(storage.load().agent.disabledProjectSkills).toEqual({})
  })
})
