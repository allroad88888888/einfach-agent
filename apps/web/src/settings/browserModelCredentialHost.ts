import {
  MODEL_CREDENTIALS,
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
  type ModelCredentialStatus,
  type ModelCredentialTarget,
  type ModelCredentialValues,
} from './modelCredentialHost'
import { sanitizeModelApiKey } from './config'

export const BROWSER_MODEL_CREDENTIAL_STORAGE_KEY = 'web-agent.model-credentials.v1'
const LEGACY_APP_SETTINGS_STORAGE_KEY = 'web-agent.settings.v1'

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function emptyCredentials(): ModelCredentialValues {
  return Object.fromEntries(
    MODEL_CREDENTIALS.map(({ target }) => [target.provider, '']),
  ) as ModelCredentialValues
}

function hasCredential(target: ModelCredentialTarget, credentials: ModelCredentialValues): boolean {
  return credentials[target.provider].length > 0
}

function readCredentials(storage: BrowserStorage): ModelCredentialValues {
  const raw = storage.getItem(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY)
  if (!raw) return migrateLegacyDeepSeekCredential(storage)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('浏览器模型密钥格式无效')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('浏览器模型密钥格式无效')
  }
  const values = (parsed as { credentials?: unknown }).credentials
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('浏览器模型密钥格式无效')
  }

  const credentials = emptyCredentials()
  for (const { target } of MODEL_CREDENTIALS) {
    const value = (values as Record<string, unknown>)[target.provider]
    if (value === undefined) continue
    credentials[target.provider] = sanitizeModelApiKey(value).trim()
  }
  return credentials
}

function migrateLegacyDeepSeekCredential(storage: BrowserStorage): ModelCredentialValues {
  const credentials = emptyCredentials()
  const raw = storage.getItem(LEGACY_APP_SETTINGS_STORAGE_KEY)
  if (!raw) return credentials

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown
      providers?: { deepseek?: { apiKey?: unknown } }
    }
    if (parsed.version !== 1) return credentials
    const value = parsed.providers?.deepseek?.apiKey
    if (typeof value !== 'string') return credentials
    credentials.deepseek = sanitizeModelApiKey(value).trim()
    if (credentials.deepseek) writeCredentials(storage, credentials)
  } catch {
    // The normal app-settings migration owns invalid legacy envelopes; this path must not block boot.
  }
  return credentials
}

function writeCredentials(storage: BrowserStorage, credentials: ModelCredentialValues): void {
  if (Object.values(credentials).every((value) => !value)) {
    storage.removeItem(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY)
    return
  }
  storage.setItem(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY, JSON.stringify({ version: 1, credentials }))
}

function browserStorage(): BrowserStorage | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // Sandboxed documents can expose localStorage while denying every access to it.
  }
  return undefined
}

function statusFor(
  target: ModelCredentialTarget,
  credentials: ModelCredentialValues,
): ModelCredentialStatus {
  return hasCredential(target, credentials)
    ? { configured: true, source: 'browser' }
    : { configured: false, source: 'missing' }
}

/** Stores static-deployment BYOK credentials only in this browser's localStorage. */
export function createBrowserModelCredentialHost(
  storage: BrowserStorage | undefined = browserStorage(),
): ModelCredentialHost {
  if (!storage) return createUnavailableModelCredentialHost()

  return {
    available: true,
    status: async (target) => statusFor(target, readCredentials(storage)),
    save: async (target, apiKey) => {
      const value = sanitizeModelApiKey(apiKey).trim()
      if (!value) throw new Error('请输入模型 API Key')
      const credentials = readCredentials(storage)
      credentials[target.provider] = value
      writeCredentials(storage, credentials)
      return statusFor(target, credentials)
    },
    delete: async (target) => {
      const credentials = readCredentials(storage)
      credentials[target.provider] = ''
      writeCredentials(storage, credentials)
      return statusFor(target, credentials)
    },
    modelCredentials: () => {
      try {
        return readCredentials(storage)
      } catch {
        // A malformed local value must not stop the static app from booting or become an API key.
        return emptyCredentials()
      }
    },
  }
}
