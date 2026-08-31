import {
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
  type ProviderTransportInput,
  type ProviderSettings,
} from '@einfach-agent/ai'
import { afterEach, describe, expect, it } from 'vitest'
import { createProviderFetch, providerInputForFetch } from './providerFetch'
import { replaceOpenAiCompatConnections } from './openAiCompatRegistry'

const SHARED_URL = 'https://shared.example.com/v1'

function profile(id: string, baseUrl = SHARED_URL) {
  return { id, kind: 'openai-compatible' as const, baseUrl, models: [{ id: 'secret-model' }], apiKey: 'secret-key' }
}

function adapter() {
  const resolved = defaultProviderRegistry.resolve(OPENAI_COMPAT_VENDOR_ID)
  if (!resolved) throw new Error('openai-compat adapter 未注册')
  return resolved
}

async function call(connectionId: string, seen: ProviderTransportInput[]): Promise<void> {
  await adapter().call(
    {
      body: { model: 'model', messages: [] },
      settings: { vendor: OPENAI_COMPAT_VENDOR_ID, connectionId } as ProviderSettings & {
        connectionId: string
      },
    },
    {
      apiKey: 'local-placeholder',
      retry: { maxRetries: 0 },
      fetchImpl: createProviderFetch({
        request: async (input) => {
          seen.push(input)
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        },
      }),
    },
  )
}

afterEach(() => replaceOpenAiCompatConnections([]))

describe('connection profile transport association', () => {
  it('keeps duplicate profile URLs isolated by the temporary ID carrier', async () => {
    replaceOpenAiCompatConnections([profile('alpha'), profile('beta')])
    const seen: ProviderTransportInput[] = []

    await call('alpha', seen)
    await call('beta', seen)

    expect(seen.map(({ target }) => target)).toEqual([
      {
        provider: 'openai-compat', scope: 'default', method: 'POST',
        path: '/chat/completions', connectionId: 'alpha',
      },
      {
        provider: 'openai-compat', scope: 'default', method: 'POST',
        path: '/chat/completions', connectionId: 'beta',
      },
    ])
    expect(JSON.stringify(seen)).not.toContain(SHARED_URL)
    expect(JSON.stringify(seen)).not.toContain('X-Web-Agent')
    expect(JSON.stringify(seen)).not.toContain('local-placeholder')
    expect(JSON.stringify(seen)).not.toContain('secret-model')
    expect(JSON.stringify(seen)).not.toContain('secret-key')
  })

  it('rejects an ID paired with a different profile URL before transport', async () => {
    replaceOpenAiCompatConnections([
      profile('alpha', 'https://alpha.example.com/v1'),
      profile('beta', 'https://beta.example.com/v1'),
    ])
    const mismatched = createOpenAiCompatAdapter({
      connectionBaseUrl: () => 'https://beta.example.com/v1',
    })
    const seen: ProviderTransportInput[] = []
    await expect(mismatched.call(
      {
        body: { model: 'model', messages: [] },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID, connectionId: 'alpha' } as ProviderSettings & {
          connectionId: string
        },
      },
      {
        apiKey: 'local-placeholder', fetchImpl: createProviderFetch({
          request: async (input) => { seen.push(input); return new Response() },
        }),
        retry: { maxRetries: 0 },
      },
    )).rejects.toThrow('network_error')
    expect(seen).toHaveLength(0)
  })

  it('unknown and deleted IDs fail before the closed transport is called', async () => {
    replaceOpenAiCompatConnections([profile('alpha')])
    replaceOpenAiCompatConnections([])
    const seen: ProviderTransportInput[] = []

    await expect(call('alpha', seen)).rejects.toThrow('missing_base_url')
    await expect(call('unknown', seen)).rejects.toThrow('missing_base_url')
    expect(seen).toHaveLength(0)
  })
})
