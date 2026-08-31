import {
  APP_SETTINGS_VERSION,
  createInstallationId,
  createDefaultAppSettings,
  isInstallationId,
  sanitizeAppSettings,
  sanitizeCustomInstructions,
  type AppSettings,
} from './config'
import { normalizeDisabledProjectSkills } from '@einfach-agent/core/skills'

export const APP_SETTINGS_STORAGE_KEY = 'web-agent.settings.v1'
export const LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY = 'web-agent.custom-instructions.v1'

export interface AppSettingsStorage {
  load(): AppSettings
  save(settings: AppSettings): void
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    version: APP_SETTINGS_VERSION,
    installationId: settings.installationId,
    ...(settings.defaultModelConnection === undefined
      ? {}
      : { defaultModelConnection: { ...settings.defaultModelConnection } }),
    agent: {
      customInstructions: settings.agent.customInstructions,
      disabledProjectSkills: normalizeDisabledProjectSkills(settings.agent.disabledProjectSkills),
    },
  }
}

function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(sanitizeAppSettings(settings))
}

function validGeneratedInstallationId(factory: () => string): string {
  const installationId = factory()
  if (!isInstallationId(installationId)) throw new Error('应用设置格式无效')
  return installationId
}

function settingsWithInstallationId(
  parsed: Record<string, unknown>,
  installationIdFactory: () => string,
): { settings: AppSettings; repairedInstallationId: boolean } {
  const persistedInstallationId = parsed.installationId
  const repairedInstallationId = !isInstallationId(persistedInstallationId)
  const settings = sanitizeAppSettings({
    ...parsed,
    version: APP_SETTINGS_VERSION,
    installationId: repairedInstallationId
      ? validGeneratedInstallationId(installationIdFactory)
      : persistedInstallationId,
  })
  return { settings, repairedInstallationId }
}

function parseSettings(
  raw: string,
  installationIdFactory: () => string,
): {
  settings: AppSettings
  migratedCredential: boolean
  migratedLegacySettings: boolean
  repairedInstallationId: boolean
} {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('应用设置格式无效')
  }
  const record = parsed as Record<string, unknown>
  if (record.version === APP_SETTINGS_VERSION) {
    return {
      ...settingsWithInstallationId(record, installationIdFactory),
      migratedCredential: false,
      migratedLegacySettings: false,
    }
  }
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) {
    throw new Error('应用设置格式无效')
  }

  const { settings, repairedInstallationId } = settingsWithInstallationId(record, installationIdFactory)
  return {
    settings,
    repairedInstallationId,
    migratedCredential: canContainLegacyCredential(record),
    migratedLegacySettings: true,
  }
}

function canContainLegacyCredential(record: Record<string, unknown>): boolean {
  const providers = record.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return false
  return Object.values(providers).some((provider) => (
    typeof provider === 'object'
    && provider !== null
    && !Array.isArray(provider)
    && typeof (provider as { apiKey?: unknown }).apiKey === 'string'
  ))
}

function parseLegacyCustomInstructions(
  raw: string,
  installationIdFactory: () => string,
): AppSettings {
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object'
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
  ) {
    throw new Error('应用设置格式无效')
  }
  const settings = createDefaultAppSettings(validGeneratedInstallationId(installationIdFactory))
  settings.agent.customInstructions = sanitizeCustomInstructions(
    (parsed as { customInstructions?: unknown }).customInstructions,
  )
  return settings
}

export function createAppSettingsStorage(
  storage: StorageLike,
  options: { createInstallationId?: () => string } = {},
): AppSettingsStorage {
  const installationIdFactory = options.createInstallationId ?? createInstallationId
  // Some WebViews expose readable localStorage while rejecting writes. Keep a shadow after a
  // failed repair/create write so repeated loads in the same runtime do not rotate user_id.
  let volatileSettings: AppSettings | undefined

  const persistBestEffort = (settings: AppSettings): void => {
    try {
      storage.setItem(APP_SETTINGS_STORAGE_KEY, serializeSettings(settings))
      volatileSettings = undefined
    } catch {
      volatileSettings = cloneSettings(settings)
    }
  }

  const persistCredentialMigration = (settings: AppSettings): void => {
    const serialized = serializeSettings(settings)
    try {
      storage.setItem(APP_SETTINGS_STORAGE_KEY, serialized)
      if (storage.getItem(APP_SETTINGS_STORAGE_KEY) === serialized) {
        volatileSettings = undefined
        return
      }
    } catch {
      // Fall through and remove the legacy record rather than retaining its credential.
    }
    try {
      storage.removeItem(APP_SETTINGS_STORAGE_KEY)
      if (storage.getItem(APP_SETTINGS_STORAGE_KEY) === null) {
        volatileSettings = cloneSettings(settings)
        return
      }
    } catch {
      // The error below must stay credential-free because the old record can contain the key.
    }
    volatileSettings = undefined
    throw new Error('无法安全清理旧版模型凭据，请清除应用网站数据后重试')
  }

  return {
    load() {
      if (volatileSettings) return cloneSettings(volatileSettings)

      let raw: string | null
      try {
        raw = storage.getItem(APP_SETTINGS_STORAGE_KEY)
      } catch {
        const settings = createDefaultAppSettings(
          validGeneratedInstallationId(installationIdFactory),
        )
        volatileSettings = cloneSettings(settings)
        return settings
      }
      if (raw) {
        const {
          settings,
          migratedCredential,
          migratedLegacySettings,
          repairedInstallationId,
        } = parseSettings(raw, installationIdFactory)
        if (migratedCredential) persistCredentialMigration(settings)
        else if (migratedLegacySettings || repairedInstallationId) persistBestEffort(settings)
        return settings
      }

      let legacyRaw: string | null
      try {
        legacyRaw = storage.getItem(LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY)
      } catch {
        const settings = createDefaultAppSettings(
          validGeneratedInstallationId(installationIdFactory),
        )
        volatileSettings = cloneSettings(settings)
        return settings
      }
      if (!legacyRaw) {
        const settings = createDefaultAppSettings(
          validGeneratedInstallationId(installationIdFactory),
        )
        persistBestEffort(settings)
        return settings
      }

      const migrated = parseLegacyCustomInstructions(legacyRaw, installationIdFactory)
      persistBestEffort(migrated)
      return migrated
    },
    save(settings) {
      try {
        storage.setItem(APP_SETTINGS_STORAGE_KEY, serializeSettings(settings))
        volatileSettings = undefined
      } catch (error) {
        volatileSettings = cloneSettings(settings)
        throw error
      }
    },
  }
}

export function createMemoryAppSettingsStorage(
  initial: AppSettings = createDefaultAppSettings(),
): AppSettingsStorage {
  let settings = sanitizeAppSettings(initial)
  return {
    load: () => cloneSettings(settings),
    save(next) {
      settings = sanitizeAppSettings(next)
    },
  }
}

export function createBrowserAppSettingsStorage(): AppSettingsStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return createAppSettingsStorage(window.localStorage)
    }
  } catch {
    // Sandboxed WebViews may expose localStorage but reject access.
  }
  return createMemoryAppSettingsStorage()
}
