import { describe, expect, expectTypeOf, it } from 'vitest'
import { type DeepSeekReasoningEffort } from './deepseek'
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

async function requestEffort(effort: unknown, thinking: 'enabled' | 'disabled' = 'enabled') {
  const captured = capture()
  await callModel(
    {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: thinking },
      settings: { vendor: 'deepseek', ...(effort === undefined ? {} : { reasoning_effort: effort }) },
    },
    { apiKey: 'test-key', fetchImpl: captured.fetchImpl, retry: { maxRetries: 0 } },
  )
  return captured.body()
}

describe('DeepSeek V4 Thinking effort projection', () => {
  it('has the exact three-value wire union', () => {
    expectTypeOf<DeepSeekReasoningEffort>().toEqualTypeOf<'low' | 'high' | 'max'>()
  })

  it.each(['low', 'high', 'max'] as const)('sends enabled %s without remapping it', async (effort) => {
    await expect(requestEffort(effort)).resolves.toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: effort,
    })
  })

  it.each([
    ['Auto', undefined, 'enabled'],
    ['Off', 'max', 'disabled'],
    ['historical medium', 'medium', 'enabled'],
    ['historical xhigh', 'xhigh', 'enabled'],
    ['unknown value', 'turbo', 'enabled'],
  ] as const)('%s never sends an effort literal', async (_name, effort, thinking) => {
    await expect(requestEffort(effort, thinking)).resolves.not.toHaveProperty('reasoning_effort')
  })
})
