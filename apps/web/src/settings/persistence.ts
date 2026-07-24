import {
  APP_SETTINGS_VERSION,
  createInstallationId,
  createDefaultAppSettings,
  isInstallationId,
  sanitizeAppSettings,
  sanitizeCustomInstructions,
  type AppSettings,
} from './config'

export const APP_SETTINGS_STORAGE_KEY = 'web-agent.settings.v1'
export const LEGACY_CUSTOM_INSTRUCTIONS_STORAGE_KEY = 'web-agent.custom-instructions.v1'

export interface AppSettingsStorage {
  load(): AppSettings
  save(settings: AppSettings): void
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    version: APP_SETTINGS_VERSION,
    installationId: settings.installationId,
    agent: {
      customInstructions: settings.agent.customInstructions,
    },
    providers: {
      deepseek: {
        apiKey: settings.providers.deepseek.apiKey,
      },
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

function parseSettings(
  raw: string,
  installationIdFactory: () => string,
): { settings: AppSettings; repairedInstallationId: boolean } {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('应用设置格式无效')
  }

  const persistedInstallationId = (parsed as { installationId?: unknown }).installationId
  const repairedInstallationId = !isInstallationId(persistedInstallationId)
  const settings = sanitizeAppSettings({
    ...parsed,
    installationId: repairedInstallationId
      ? validGeneratedInstallationId(installationIdFactory)
      : persistedInstallationId,
  })
  return { settings, repairedInstallationId }
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
        const { settings, repairedInstallationId } = parseSettings(raw, installationIdFactory)
        if (repairedInstallationId) persistBestEffort(settings)
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
