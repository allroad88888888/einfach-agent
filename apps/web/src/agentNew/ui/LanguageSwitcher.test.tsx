import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '@lingui/react'
import { activateLocale, appI18n, localePreferenceAtom } from '../../i18n'
import { renderWithStore } from '../../test/renderWithStore'
import { LanguageSwitcher } from './LanguageSwitcher'

function renderSwitcher() {
  return renderWithStore(
    <I18nProvider i18n={appI18n}>
      <LanguageSwitcher />
    </I18nProvider>,
  )
}

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    await activateLocale('zh-CN')
  })

  it('中文模式聚焦时标示中文为当前语言', async () => {
    const user = userEvent.setup()
    renderSwitcher()

    const chineseButton = screen.getByRole('button', { name: '中文' })
    expect(chineseButton).toHaveAttribute('aria-pressed', 'true')

    await user.tab()
    expect(chineseButton).toHaveFocus()
  })

  it('选择 English 后写入语言偏好并更新当前选择', async () => {
    const user = userEvent.setup()
    const { store } = renderSwitcher()
    const englishButton = screen.getByRole('button', { name: 'English' })

    await user.click(englishButton)

    expect(store.getter(localePreferenceAtom)).toBe('en')
    expect(englishButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('英语激活时使用英语可访问名称', async () => {
    await activateLocale('en')
    renderSwitcher()

    expect(screen.getByRole('group', { name: 'Language' })).toBeVisible()
  })
})
