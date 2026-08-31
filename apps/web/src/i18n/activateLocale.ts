import type { Messages } from '@lingui/core'
import { createCatalogActivator } from './catalogActivator'
import { appI18n } from './i18nInstance'
import type { AppLocale } from './locales'

type CompiledCatalog = { messages: Messages }

async function loadCatalog(locale: AppLocale): Promise<Messages> {
  const catalog: CompiledCatalog = locale === 'en'
    ? await import('./locales/en/messages.po')
    : await import('./locales/zh-CN/messages.po')
  return catalog.messages
}

export const activateLocale = createCatalogActivator(appI18n, loadCatalog)
