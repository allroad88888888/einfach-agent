import { DEFAULT_LOCALE, normalizeLocale, type AppLocale } from './locales'

export const LOCALE_STORAGE_KEY = 'web-agent.locale.v1'

export interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): LocaleStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function readLocalePreference(storage: LocaleStorage | undefined = browserStorage()): AppLocale {
  if (!storage) return DEFAULT_LOCALE
  try {
    return normalizeLocale(storage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}

export function persistLocalePreference(
  locale: AppLocale,
  storage: LocaleStorage | undefined = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // A denied or full localStorage must not make language switching fail.
  }
}
