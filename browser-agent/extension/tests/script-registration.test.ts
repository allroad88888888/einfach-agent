import { beforeEach, expect, it, vi } from 'vitest'
import { disposeRemovedOrigins, syncRegisteredScripts } from '../src/script-registration'
import manifest from '../manifest.json'

const unregisterContentScripts = vi.fn().mockResolvedValue(undefined)
const registerContentScripts = vi.fn().mockResolvedValue(undefined)
const getRegisteredContentScripts = vi.fn().mockResolvedValue([])
const executeScript = vi.fn().mockResolvedValue([])

beforeEach(() => {
  unregisterContentScripts.mockClear(); registerContentScripts.mockClear(); getRegisteredContentScripts.mockClear(); executeScript.mockClear()
  vi.stubGlobal('chrome', { permissions: { getAll: vi.fn().mockResolvedValue({ origins: ['https://allowed.test/*', 'chrome://settings/*'] }) }, tabs: { query: vi.fn().mockResolvedValue([]) }, scripting: { unregisterContentScripts, registerContentScripts, getRegisteredContentScripts, executeScript } })
})

it('registers both worlds at document_start for granted web origins only and serializes concurrent sync', async () => {
  await Promise.all([syncRegisteredScripts(), syncRegisteredScripts()])
  expect(registerContentScripts).toHaveBeenCalledTimes(1)
  for (const [scripts] of registerContentScripts.mock.calls) {
    expect(scripts).toEqual([
      expect.objectContaining({ matches: ['https://allowed.test/*'], js: ['content-script.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false }),
      expect.objectContaining({ matches: ['https://allowed.test/*'], js: ['network-main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false }),
    ])
  }
})

it('recovers the serialized queue after a transient registration failure', async () => {
  const getAll = vi.fn().mockResolvedValue({ origins: ['https://retry.test/*'] })
  registerContentScripts.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined)
  vi.stubGlobal('chrome', { permissions: { getAll }, tabs: { query: vi.fn().mockResolvedValue([]) }, scripting: { unregisterContentScripts, registerContentScripts, getRegisteredContentScripts, executeScript } })
  await expect(syncRegisteredScripts()).rejects.toThrow('temporary')
  await expect(syncRegisteredScripts()).resolves.toBeUndefined()
  expect(registerContentScripts).toHaveBeenCalledTimes(2)
})

it('does not inject page or network scripts into OCR service origins', async () => {
  vi.mocked(chrome.permissions.getAll).mockResolvedValue({ origins: [...manifest.host_permissions, 'https://business.test/*'] })
  vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 1, url: 'https://paddleocr.aistudio-app.com/' }, { id: 2, url: 'https://business.test/' }])
  await syncRegisteredScripts()
  expect(registerContentScripts).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ matches: ['https://business.test/*'] })]))
  expect(executeScript.mock.calls.every(([call]) => call.target.tabId === 2)).toBe(true)
})

it('cleans open tabs matched by wildcard permission patterns', async () => {
  const executeScript = vi.fn().mockResolvedValue([])
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 9, url: 'https://app.example.com/page' }, { id: 10, url: 'https://other.test/' }]) }, scripting: { executeScript } })
  await disposeRemovedOrigins(['https://*.example.com/*'])
  expect(executeScript).toHaveBeenCalledTimes(1)
  expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 9, frameIds: [0] }, world: 'MAIN' }))
})

it('keeps semantically identical registrations and injects every already-open authorized tab independently', async () => {
  const scripts = [
    { id: 'einfach-network-main', matches: ['https://open.test/*'], js: ['network-main.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true, world: 'MAIN', extraChromeField: true },
    { id: 'einfach-page-isolated', matches: ['https://open.test/*'], js: ['content-script.js'], runAt: 'document_start', world: 'ISOLATED' },
  ]
  const tabInjection = vi.fn()
    .mockRejectedValueOnce(new Error('restricted tab'))
    .mockResolvedValue([])
  vi.stubGlobal('chrome', {
    permissions: { getAll: vi.fn().mockResolvedValue({ origins: ['https://open.test/*'] }) },
    tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://open.test/one' }, { id: 2, url: 'https://open.test/two' }, { id: 3, url: 'https://not-authorized.test/' }]) },
    scripting: { unregisterContentScripts, registerContentScripts, getRegisteredContentScripts: vi.fn().mockResolvedValue(scripts), executeScript: tabInjection },
  })
  await expect(syncRegisteredScripts()).resolves.toBeUndefined()
  expect(unregisterContentScripts).not.toHaveBeenCalled()
  expect(registerContentScripts).not.toHaveBeenCalled()
  expect(tabInjection.mock.calls.some(([call]) => call.target.tabId === 2 && call.world === 'MAIN')).toBe(true)
  expect(tabInjection.mock.calls.some(([call]) => call.target.tabId === 3)).toBe(false)
})
