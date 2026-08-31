import { setupI18n, type MessageDescriptor } from '@lingui/core'
import { appI18n } from './i18nInstance'

const sourceI18n = setupI18n({ locale: 'zh-CN' })

/** Translates a macro descriptor while pure UI helpers are still bootstrapping. */
export function translateMessage(message: MessageDescriptor): string {
  return (appI18n.locale ? appI18n : sourceI18n)._(message)
}
