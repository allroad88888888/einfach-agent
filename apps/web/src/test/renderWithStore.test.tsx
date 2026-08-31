import { Trans, useLingui } from '@lingui/react'
import { createStore } from '@einfach/core'
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { activateLocale, appI18n, localePreferenceAtom } from '../i18n'
import { LOCALE_STORAGE_KEY } from '../i18n/localeStorage'
import { renderWithStore } from './renderWithStore'

function I18nProbe(): React.JSX.Element {
  const { i18n } = useLingui()

  return (
    <>
      <output aria-label="active locale">{i18n.locale}</output>
      <Trans id="puBmv5" />
    </>
  )
}

describe('renderWithStore', () => {
  afterEach(async () => {
    await activateLocale('zh-CN')
    document.documentElement.lang = 'zh-CN'
  })

  it('synchronously provides the real default Chinese catalog to Lingui consumers', () => {
    renderWithStore(<I18nProbe />)

    expect(screen.getByLabelText('active locale')).toHaveTextContent('zh-CN')
    expect(screen.getByText('新建工作区')).toBeInTheDocument()
  })

  it('keeps an explicitly activated English locale for a supplied UI store', async () => {
    const store = createStore()
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    await activateLocale('en')
    const { unmount } = renderWithStore(<I18nProbe />, { store })

    expect(store.getter(localePreferenceAtom)).toBe('en')
    expect(screen.getByLabelText('active locale')).toHaveTextContent('en')
    expect(screen.getByText('New workspace')).toBeInTheDocument()

    unmount()
    await activateLocale('zh-CN')
    renderWithStore(<I18nProbe />)

    expect(appI18n.locale).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(storedLocale)
  })
})
