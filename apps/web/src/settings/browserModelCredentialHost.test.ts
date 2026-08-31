import { describe, expect, it } from 'vitest'
import {
  BROWSER_MODEL_CREDENTIAL_STORAGE_KEY,
  createBrowserModelCredentialHost,
} from './browserModelCredentialHost'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  }
}

describe('browser model credential host', () => {
  it('keeps a static BYOK key in browser storage while only exposing configured status', async () => {
    const { storage, values } = memoryStorage()
    const host = createBrowserModelCredentialHost(storage)
    const target = { provider: 'deepseek', scope: 'default' } as const

    await expect(host.status(target)).resolves.toEqual({ configured: false, source: 'missing' })
    await expect(host.save(target, ' browser-deepseek-key ')).resolves.toEqual({
      configured: true,
      source: 'browser',
    })
    await expect(host.status(target)).resolves.toEqual({ configured: true, source: 'browser' })
    expect(JSON.parse(values.get(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY) ?? '')).toEqual({
      version: 1,
      credentials: {
        deepseek: 'browser-deepseek-key',
        glm: '',
        kimi: '',
        'openai-compat': '',
      },
    })
    expect(host.modelCredentials?.()).toMatchObject({ deepseek: 'browser-deepseek-key' })

    await expect(host.delete(target)).resolves.toEqual({ configured: false, source: 'missing' })
    expect(values.has(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY)).toBe(false)
  })

  it('does not turn malformed browser data into a usable credential', async () => {
    const { storage, values } = memoryStorage()
    values.set(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY, '{not-json')
    const host = createBrowserModelCredentialHost(storage)

    await expect(host.status({ provider: 'deepseek', scope: 'default' })).rejects.toThrow(
      '浏览器模型密钥格式无效',
    )
    expect(host.modelCredentials?.()).toEqual({
      deepseek: '', glm: '', kimi: '', 'openai-compat': '',
    })
  })

  it('moves the version 4 DeepSeek key out of the old app-settings envelope on static boot', async () => {
    const { storage, values } = memoryStorage()
    values.set('web-agent.settings.v1', JSON.stringify({
      version: 1,
      installationId: 'ignored-by-credential-migration',
      agent: { customInstructions: '' },
      providers: { deepseek: { apiKey: 'version-four-key' } },
    }))

    const host = createBrowserModelCredentialHost(storage)

    await expect(host.status({ provider: 'deepseek', scope: 'default' })).resolves.toEqual({
      configured: true,
      source: 'browser',
    })
    expect(host.modelCredentials?.()).toMatchObject({ deepseek: 'version-four-key' })
    expect(values.get(BROWSER_MODEL_CREDENTIAL_STORAGE_KEY)).toContain('version-four-key')
  })
})
