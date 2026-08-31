import { describe, expect, it } from 'vitest'
import { callKimi } from './kimi'
import { DEFAULT_KIMI_MODEL, KIMI_K3_MODEL } from './kimiRegion'
import { callModel, streamModel } from './modelAdapter'

function jsonResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function sseResponse(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function captureCall(reasoningEffort?: unknown): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined
  await callModel(
    {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      settings: {
        vendor: 'kimi',
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      },
    },
    {
      apiKey: 'test-key',
      retry: { maxRetries: 0 },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse()
      },
    },
  )
  if (body === undefined) throw new Error('Expected a fetch request.')
  return body
}

describe('Kimi K3 request protocol', () => {
  it('publishes K3 as the Kimi default', () => {
    expect(KIMI_K3_MODEL).toBe('kimi-k3')
    expect(DEFAULT_KIMI_MODEL).toBe(KIMI_K3_MODEL)
  })

  it.each(['low', 'high', 'max'] as const)('sends the %s effort unchanged', async (effort) => {
    const body = await captureCall(effort)

    expect(body).toHaveProperty('reasoning_effort', effort)
    expect(body).not.toHaveProperty('thinking')
  })

  it('represents Auto by omitting effort', async () => {
    const body = await captureCall()

    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
  })

  it.each(['medium', 'xhigh', 'minimal', 'none', 'dirty'])('drops dirty effort %s', async (effort) => {
    const body = await captureCall(effort)

    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
  })

  it('strips thinking on a direct non-streaming call and defaults to CN', async () => {
    let url = ''
    let body: Record<string, unknown> = {}
    await callKimi(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      },
      {
        apiKey: 'test-key',
        retry: { maxRetries: 0 },
        fetchImpl: async (input, init) => {
          url = String(input)
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse()
        },
      },
    )

    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(body).toMatchObject({
      model: 'kimi-k3',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(body).not.toHaveProperty('thinking')
  })

  it('drops a dirty effort on the direct call boundary', async () => {
    let body: Record<string, unknown> = {}
    await callKimi(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
      } as unknown as Parameters<typeof callKimi>[0],
      {
        apiKey: 'test-key',
        retry: { maxRetries: 0 },
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse()
        },
      },
    )

    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
  })

  it('keeps global streaming while stripping thinking', async () => {
    let url = ''
    let body: Record<string, unknown> = {}
    await streamModel(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled' },
        settings: { vendor: 'kimi', region: 'global', reasoning_effort: 'max' },
      },
      {
        apiKey: 'test-key',
        retry: { maxRetries: 0 },
        fetchImpl: async (input, init) => {
          url = String(input)
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse()
        },
      },
    )

    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions')
    expect(body).toMatchObject({
      model: 'kimi-k3',
      reasoning_effort: 'max',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(body).not.toHaveProperty('thinking')
  })
})
