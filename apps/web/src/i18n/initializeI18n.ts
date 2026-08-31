import type { Store } from '@einfach/core'
import { activateLocale } from './activateLocale'
import { hydrateLocalePreference } from './localePreferenceAtom'
import type { LocaleStorage } from './localeStorage'
import type { AppLocale } from './locales'

export async function initializeI18n(store: Store, storage?: LocaleStorage): Promise<AppLocale> {
  const locale = hydrateLocalePreference(store, storage)
  await activateLocale(locale)
  return locale
}
