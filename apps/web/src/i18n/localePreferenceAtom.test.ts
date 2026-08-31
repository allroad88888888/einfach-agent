import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { hydrateLocalePreference, localePreferenceAtom } from './localePreferenceAtom'
import { LOCALE_STORAGE_KEY } from './localeStorage'

describe('localePreferenceAtom', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to Chinese when no preference was stored', () => {
    const store = createStore()

    expect(hydrateLocalePreference(store)).toBe('zh-CN')
    expect(store.getter(localePreferenceAtom)).toBe('zh-CN')
  })

  it('switches to English and persists the preference', () => {
    const store = createStore()

    store.setter(localePreferenceAtom, 'en')

    expect(store.getter(localePreferenceAtom)).toBe('en')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
  })

  it('restores the persisted preference into a fresh store after reload', () => {
    const previousPageStore = createStore()
    previousPageStore.setter(localePreferenceAtom, 'en')
    const reloadedPageStore = createStore()

    expect(hydrateLocalePreference(reloadedPageStore)).toBe('en')
    expect(reloadedPageStore.getter(localePreferenceAtom)).toBe('en')
  })

  it('falls back to Chinese for an invalid stored locale', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
    const store = createStore()

    expect(hydrateLocalePreference(store)).toBe('zh-CN')
    expect(store.getter(localePreferenceAtom)).toBe('zh-CN')
  })

  it('falls back safely when browser storage is inaccessible', () => {
    const store = createStore()
    const inaccessibleStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }

    expect(hydrateLocalePreference(store, inaccessibleStorage)).toBe('zh-CN')
    expect(store.getter(localePreferenceAtom)).toBe('zh-CN')
  })
})
