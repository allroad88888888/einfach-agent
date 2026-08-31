import { describe, expect, it } from 'vitest'
import {
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
} from './builtinProviders'
import { callModel } from './modelAdapter'

function response(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function capture(): { readonly fetchImpl: typeof fetch; body(): Record<string, unknown> } {
  let request: Record<string, unknown> | undefined
  return {
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return response()
    },
    body() {
      if (request === undefined) throw new Error('Expected a fetch request.')
      return request
    },
  }
}

function options(fetchImpl: typeof fetch) {
  return { apiKey: 'test-key', fetchImpl, retry: { maxRetries: 0 } }
}

function modelRequest(
  vendor: string,
  model: string,
  thinking: 'enabled' | 'disabled' = 'enabled',
  reasoning_effort?: unknown,
) {
  return {
    model,
    messages: [{ role: 'user' as const, content: 'hi' }],
    thinking: { type: thinking },
    settings: { vendor, ...(reasoning_effort === undefined ? {} : { reasoning_effort }) },
  }
}

describe('Thinking request projection', () => {
  it.each([
    ['DeepSeek valid low effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'low', 'low'],
    ['DeepSeek valid high effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'high', 'high'],
    ['DeepSeek valid effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'max', 'max'],
    ['DeepSeek Auto', 'deepseek', 'deepseek-v4-pro', 'enabled', undefined, undefined],
    ['DeepSeek disabled', 'deepseek', 'deepseek-v4-pro', 'disabled', 'max', undefined],
    ['DeepSeek historical medium effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'medium', undefined],
    ['DeepSeek historical xhigh effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'xhigh', undefined],
    ['DeepSeek dirty effort', 'deepseek', 'deepseek-v4-pro', 'enabled', 'unknown', undefined],
    ['GLM-5.2 valid low', 'glm', 'glm-5.2', 'enabled', 'low', 'low'],
    ['GLM-5.2 valid medium', 'glm', 'glm-5.2', 'enabled', 'medium', 'medium'],
    ['GLM-5.2 valid high', 'glm', 'glm-5.2', 'enabled', 'high', 'high'],
    ['GLM-5.2 valid xhigh', 'glm', 'glm-5.2', 'enabled', 'xhigh', 'xhigh'],
    ['GLM-5.2 valid max', 'glm', 'glm-5.2', 'enabled', 'max', 'max'],
    ['GLM-5.2 dirty effort', 'glm', 'glm-5.2', 'enabled', 'none-other', undefined],
    ['GLM toggle-only model', 'glm', 'glm-5.1', 'enabled', 'max', undefined],
  ] as const)(
    '%s sends only its documented reasoning effort',
    async (_name, vendor, model, thinking, effort, expectedEffort) => {
      const captured = capture()
      await callModel(modelRequest(vendor, model, thinking, effort), options(captured.fetchImpl))

      expect(captured.body()).toMatchObject({ model, thinking: { type: thinking } })
      if (expectedEffort === undefined) expect(captured.body()).not.toHaveProperty('reasoning_effort')
      else expect(captured.body()).toHaveProperty('reasoning_effort', expectedEffort)
    },
  )

  it('normalizes GLM-5.2 minimal and none aliases to disabled without an effort', async () => {
    for (const alias of ['minimal', 'none']) {
      const captured = capture()
      await callModel(modelRequest('glm', 'glm-5.2', 'enabled', alias), options(captured.fetchImpl))

      expect(captured.body()).toMatchObject({ thinking: { type: 'disabled' } })
      expect(captured.body()).not.toHaveProperty('reasoning_effort')
    }
  })

  it.each([
    ['DeepSeek', 'deepseek', 'deepseek-v4-pro', 'high'],
    ['GLM-5.2', 'glm', 'glm-5.2', 'max'],
  ] as const)('%s does not send effort until Thinking is enabled', async (_name, vendor, model, effort) => {
    const captured = capture()
    await callModel(
      {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        settings: { vendor, reasoning_effort: effort },
      },
      options(captured.fetchImpl),
    )

    expect(captured.body()).not.toHaveProperty('thinking')
    expect(captured.body()).not.toHaveProperty('reasoning_effort')
  })

  it.each([
    ['enabled', { type: 'enabled', unexpected: 'leak' }, { type: 'enabled' }],
    ['disabled', { type: 'disabled', unexpected: 'leak' }, { type: 'disabled' }],
  ] as const)('canonicalizes %s Thinking objects before fetch', async (_name, thinking, expected) => {
    const captured = capture()
    await callModel(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
        settings: { vendor: 'deepseek', reasoning_effort: 'high' },
      },
      options(captured.fetchImpl),
    )

    expect(captured.body()).toHaveProperty('thinking', expected)
    expect(captured.body().thinking).not.toHaveProperty('unexpected')
  })

  it('fails closed for an invalid Thinking object', async () => {
    const captured = capture()
    await callModel(
      {
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'automatic', unexpected: 'leak' } as unknown as { type: 'enabled' },
        settings: { vendor: 'deepseek', reasoning_effort: 'high' },
      },
      options(captured.fetchImpl),
    )

    expect(captured.body()).not.toHaveProperty('thinking')
    expect(captured.body()).not.toHaveProperty('reasoning_effort')
  })

  it('does not give unsupported models or an execution fallback DeepSeek Thinking fields', async () => {
    for (const [vendor, model] of [
      ['glm', 'glm-4-long'],
      ['unknown-vendor', 'deepseek-v4-pro'],
    ]) {
      const captured = capture()
      await callModel(modelRequest(vendor, model, 'enabled', 'max'), options(captured.fetchImpl))

      expect(captured.body()).not.toHaveProperty('thinking')
      expect(captured.body()).not.toHaveProperty('reasoning_effort')
    }
  })

  it('keeps Kimi thinking and its message encoding without inventing an effort', async () => {
    const captured = capture()
    await callModel(modelRequest('kimi', 'kimi-k2.6', 'enabled', 'max'), options(captured.fetchImpl))

    expect(captured.body()).toMatchObject({ thinking: { type: 'enabled' } })
    expect(captured.body()).not.toHaveProperty('reasoning_effort')
    expect(captured.body().messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('does not give an OpenAI-compatible profile an unreviewed Thinking field', async () => {
    const captured = capture()
    const adapter = createOpenAiCompatAdapter({ baseUrl: 'https://compat.example/v1' })
    await adapter.call(
      {
        body: {
          model: 'profile-model',
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'enabled' },
        },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID },
      },
      options(captured.fetchImpl),
    )

    expect(captured.body()).not.toHaveProperty('thinking')
    expect(captured.body()).not.toHaveProperty('reasoning_effort')
  })
})
