import { useAtomValue, useSetAtom } from '@einfach/react'
import { useLingui } from '@lingui/react/macro'
import { localePreferenceAtom, type AppLocale } from '../../i18n'

const languageOptions: ReadonlyArray<{ locale: AppLocale, label: string }> = [
  { locale: 'zh-CN', label: '中文' },
  { locale: 'en', label: 'English' },
]

/** Selects the persisted interface language. */
export function LanguageSwitcher() {
  const { t } = useLingui()
  const locale = useAtomValue(localePreferenceAtom)
  const setLocale = useSetAtom(localePreferenceAtom)

  return (
    <div className="agentnew-language-switcher" role="group" aria-label={t`界面语言`}>
      {languageOptions.map(({ locale: optionLocale, label }) => (
        <button
          key={optionLocale}
          type="button"
          className="agentnew-language-switcher-option"
          aria-pressed={locale === optionLocale}
          onClick={() => setLocale(optionLocale)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
