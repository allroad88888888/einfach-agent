import { createStore } from '@einfach/core'
import { Provider } from '@einfach/react'
import { useLingui } from '@lingui/react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppI18nProvider } from './AppI18nProvider'
import { initializeI18n } from './initializeI18n'
import { localePreferenceAtom } from './localePreferenceAtom'

function ActiveLocale(): React.JSX.Element {
  const { i18n } = useLingui()
  return <output aria-label="active locale">{i18n.locale}</output>
}

describe('AppI18nProvider', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('refreshes consumers when the Einfach preference switches locale', async () => {
    const store = createStore()
    await initializeI18n(store)
    render(
      <Provider store={store}>
        <AppI18nProvider>
          <ActiveLocale />
        </AppI18nProvider>
      </Provider>,
    )
    expect(screen.getByLabelText('active locale')).toHaveTextContent('zh-CN')

    act(() => store.setter(localePreferenceAtom, 'en'))

    await waitFor(() => {
      expect(screen.getByLabelText('active locale')).toHaveTextContent('en')
    })
  })
})
