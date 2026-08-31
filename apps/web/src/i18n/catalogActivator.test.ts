import { setupI18n, type Messages } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { createCatalogActivator } from './catalogActivator'
import type { AppLocale } from './locales'

function deferredCatalog() {
  let resolve!: (messages: Messages) => void
  const promise = new Promise<Messages>((done) => { resolve = done })
  return { promise, resolve }
}

describe('createCatalogActivator', () => {
  it('prevents a slower old request from replacing the last selected locale', async () => {
    const i18n = setupI18n()
    const catalogs: Record<AppLocale, ReturnType<typeof deferredCatalog>> = {
      en: deferredCatalog(),
      'zh-CN': deferredCatalog(),
    }
    const activate = createCatalogActivator(i18n, (locale) => catalogs[locale].promise)

    const oldEnglishRequest = activate('en')
    const latestChineseRequest = activate('zh-CN')
    catalogs['zh-CN'].resolve({})

    await expect(latestChineseRequest).resolves.toBe(true)
    expect(i18n.locale).toBe('zh-CN')

    catalogs.en.resolve({})
    await expect(oldEnglishRequest).resolves.toBe(false)
    expect(i18n.locale).toBe('zh-CN')
  })
})
