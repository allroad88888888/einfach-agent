import { describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatAdapter } from './builtinProviders'
import { callOpenAiCompat, type OpenAiCompatChatRequest } from './openaiCompat'
import type { ProviderSettings } from './providerRegistry'

const BASE_URL = 'https://gateway.example/v1'

function imageRequest(): OpenAiCompatChatRequest {
  return {
    model: 'vision-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '描述图片' },
        {
          type: 'image',
          source: { kind: 'inline-base64', data: 'aGVsbG8=' },
          name: 'sample.png',
          mimeType: 'image/png',
          byteSize: 5,
        },
      ],
    }],
  }
}

function okResponse(): Response {
  return new Response(JSON.stringify({ choices: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('OpenAI-compatible inline image projection', () => {
  it('sends opted-in base64 images as image_url data URLs', async () => {
    let body: Record<string, unknown> | undefined
    await callOpenAiCompat(imageRequest(), {
      apiKey: 'key',
      baseUrl: BASE_URL,
      imageInput: 'inline-base64',
      retry: { maxRetries: 0 },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return okResponse()
      },
    })

    expect(body?.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '描述图片' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
    }])
  })

  it('keeps images text-only without opt-in and rejects foreign references with opt-in', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return okResponse()
    })
    await callOpenAiCompat(imageRequest(), {
      apiKey: 'key', baseUrl: BASE_URL, retry: { maxRetries: 0 }, fetchImpl,
    })
    expect(JSON.stringify(bodies[0])).not.toContain('aGVsbG8=')

    const request = imageRequest()
    const image = (request.messages[0]!.content as unknown as Array<Record<string, unknown>>)[1]!
    image.source = {
      kind: 'provider-file', provider: 'kimi', scope: 'kimi:cn', reference: 'ms://file',
    }
    await expect(callOpenAiCompat(request, {
      apiKey: 'key', baseUrl: BASE_URL, imageInput: 'inline-base64', fetchImpl,
    })).rejects.toThrow('requires base64 image data')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes the session image capability through the registered adapter', async () => {
    let body: Record<string, unknown> | undefined
    const adapter = createOpenAiCompatAdapter({ baseUrl: BASE_URL })
    await adapter.call({
      body: imageRequest(),
      settings: {
        vendor: 'openai-compat', imageInput: 'inline-base64',
      } as ProviderSettings & { imageInput: 'inline-base64' },
    }, {
      apiKey: 'key', retry: { maxRetries: 0 },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return okResponse()
      },
    })
    expect(JSON.stringify(body)).toContain('data:image/png;base64,aGVsbG8=')
  })
})
