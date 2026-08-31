import type { PropsWithChildren } from 'react'
import { useEffect } from 'react'
import { I18nProvider } from '@lingui/react'
import { useAtomValue } from '@einfach/react'
import { activateLocale } from './activateLocale'
import { appI18n } from './i18nInstance'
import { localePreferenceAtom } from './localePreferenceAtom'

export function AppI18nProvider({ children }: PropsWithChildren): React.JSX.Element {
  const locale = useAtomValue(localePreferenceAtom)

  useEffect(() => {
    document.documentElement.lang = locale
    void activateLocale(locale)
  }, [locale])

  return <I18nProvider i18n={appI18n}>{children}</I18nProvider>
}
