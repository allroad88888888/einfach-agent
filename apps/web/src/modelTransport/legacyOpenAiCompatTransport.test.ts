import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_VENDOR_ID,
  GLM_BASE_URL,
  GLM_VENDOR_ID,
  KIMI_CN_BASE_URL,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
  type ProviderTransportInput,
} from '@einfach-agent/ai'
import { afterEach, describe, expect, it } from 'vitest'
import { applyOpenAiCompatEndpoint } from './openAiCompatEndpoint'
import { createProviderFetch, providerInputForFetch } from './providerFetch'

function request(vendor: string) {
  return { body: { model: 'model', messages: [] }, settings: { vendor } }
}

function response(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
}

function capture(seen: ProviderTransportInput[]): typeof fetch {
  return createProviderFetch({
    request: async (input) => {
      seen.push(input)
      return response()
    },
  })
}

afterEach(() => applyOpenAiCompatEndpoint(undefined))

describe('legacy openai-compat transport identity', () => {
  it('keeps compat identity when its registered URL equals the DeepSeek origin', async () => {
    applyOpenAiCompatEndpoint(DEEPSEEK_BASE_URL)
    const seen: ProviderTransportInput[] = []

    await defaultProviderRegistry.resolve(OPENAI_COMPAT_VENDOR_ID)!.call(
      request(OPENAI_COMPAT_VENDOR_ID),
      { apiKey: 'placeholder', fetchImpl: capture(seen), retry: { maxRetries: 0 } },
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.target).toEqual({
      provider: 'openai-compat', scope: 'default', method: 'POST',
      path: '/chat/completions',
    })
    expect(JSON.stringify(seen[0])).not.toContain('X-Web-Agent')
    expect(JSON.stringify(seen[0])).not.toContain(DEEPSEEK_BASE_URL)
    expect(JSON.stringify(seen[0])).not.toContain('placeholder')
  })

  it.each([
    [DEEPSEEK_VENDOR_ID, DEEPSEEK_BASE_URL, 'deepseek', 'default'],
    [GLM_VENDOR_ID, GLM_BASE_URL, 'glm', 'default'],
    [KIMI_VENDOR_ID, KIMI_CN_BASE_URL, 'kimi', 'cn'],
  ] as const)('keeps the official %s identity at the same URL', async (
    vendor, baseUrl, provider, scope,
  ) => {
    applyOpenAiCompatEndpoint(baseUrl)
    const seen: ProviderTransportInput[] = []

    await defaultProviderRegistry.resolve(vendor)!.call(
      request(vendor),
      { apiKey: 'placeholder', fetchImpl: capture(seen), retry: { maxRetries: 0 } },
    )

    expect(seen[0]?.target).toEqual({
      provider, scope, method: 'POST', path: '/chat/completions',
    })
  })

  it('fails closed when closed legacy identity has no matching registered URL', async () => {
    const adapter = createOpenAiCompatAdapter({ baseUrl: 'https://unknown.example/v1' })
    const seen: ProviderTransportInput[] = []

    await expect(adapter.call(request(OPENAI_COMPAT_VENDOR_ID), {
      apiKey: 'placeholder', fetchImpl: capture(seen), retry: { maxRetries: 0 },
    })).rejects.toThrow('network_error')

    applyOpenAiCompatEndpoint('https://registered.example/v1')
    const mismatched = createOpenAiCompatAdapter({ baseUrl: DEEPSEEK_BASE_URL })
    await expect(mismatched.call(request(OPENAI_COMPAT_VENDOR_ID), {
      apiKey: 'placeholder', fetchImpl: capture(seen), retry: { maxRetries: 0 },
    })).rejects.toThrow('network_error')
    expect(seen).toHaveLength(0)
  })

  it('caller-supplied headers cannot forge the private legacy identity', () => {
    applyOpenAiCompatEndpoint(DEEPSEEK_BASE_URL)
    const input = providerInputForFetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST', body: '{}', headers: { 'X-Web-Agent-Legacy-OpenAI-Compat': '1' },
    })

    expect(input.target.provider).toBe('deepseek')
    expect(JSON.stringify(input)).not.toContain('X-Web-Agent')
  })
})
