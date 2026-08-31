import type { I18n, Messages } from '@lingui/core'
import type { AppLocale } from './locales'

export type CatalogLoader = (locale: AppLocale) => Promise<Messages>

export function createCatalogActivator(i18n: I18n, loadCatalog: CatalogLoader) {
  let latestRequest = 0

  return async (locale: AppLocale): Promise<boolean> => {
    const request = ++latestRequest
    if (i18n.locale === locale) return true

    const messages = await loadCatalog(locale)
    if (request !== latestRequest) return false

    i18n.loadAndActivate({ locale, messages })
    return true
  }
}
