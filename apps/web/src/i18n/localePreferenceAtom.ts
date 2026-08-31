import { atom, type Store } from '@einfach/core'
import { normalizeLocale, type AppLocale, DEFAULT_LOCALE } from './locales'
import {
  persistLocalePreference,
  readLocalePreference,
  type LocaleStorage,
} from './localeStorage'

const localeValueAtom = atom<AppLocale>(DEFAULT_LOCALE)
localeValueAtom.debugLabel = 'localeValue'

export const localePreferenceAtom = atom(
  (get) => get(localeValueAtom),
  (_get, set, value: AppLocale) => {
    const locale = normalizeLocale(value)
    set(localeValueAtom, locale)
    persistLocalePreference(locale)
  },
)
localePreferenceAtom.debugLabel = 'localePreference'

export function hydrateLocalePreference(store: Store, storage?: LocaleStorage): AppLocale {
  const locale = readLocalePreference(storage)
  store.setter(localeValueAtom, locale)
  return locale
}
