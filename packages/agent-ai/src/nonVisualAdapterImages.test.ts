import { describe, expect, it } from 'vitest'
import { callDeepSeek } from './deepseek'
import { streamGlm } from './glm'
import type { ModelItem, UserImageContentBlock } from './modelProtocol'

const FIRST_IMAGE: UserImageContentBlock = {
  type: 'image',
  source: {
    kind: 'provider-file',
    provider: 'kimi',
    scope: 'kimi:cn',
    reference: 'ms://private-first',
  },
  name: '发票.png',
  mimeType: 'image/png',
  byteSize: 1024,
}

const SECOND_IMAGE: UserImageContentBlock = {
  type: 'image',
  source: {
    kind: 'provider-file',
    provider: 'secret-provider',
    scope: 'secret-scope',
    reference: 'ms://private-second',
  },
  name: '现场.webp',
  mimeType: 'image/webp',
  byteSize: 2048,
}

const MIXED_MESSAGES: ModelItem[] = [{
  role: 'user',
  content: [
    { type: 'text', text: '请检查附件' },
    FIRST_IMAGE,
    { type: 'text', text: '并对比第二张' },
    SECOND_IMAGE,
  ],
}]

const EXPECTED_TEXT = [
  '请检查附件',
  '[用户上传了图片 发票.png（image/png），当前模型看不到图片内容]',
  '并对比第二张',
  '[用户上传了图片 现场.webp（image/webp），当前模型看不到图片内容]',
].join('\n')

function jsonResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(): Response {
  const source = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const encoded = new TextEncoder().encode(source)
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function requestCapture(response: Response): {
  fetchImpl: typeof fetch
  rawBody(): string
} {
  let body: string | undefined
  return {
    async fetchImpl(_input, init) {
      body = String(init?.body)
      return response
    },
    rawBody() {
      if (body === undefined) throw new Error('Expected a captured request body.')
      return body
    },
  }
}

function expectSafeFallback(rawBody: string): void {
  const parsed = JSON.parse(rawBody) as { messages: ModelItem[] }
  expect(parsed.messages).toEqual([{ role: 'user', content: EXPECTED_TEXT }])
  expect(rawBody).not.toContain('ms://')
  expect(rawBody).not.toContain('secret-provider')
  expect(rawBody).not.toContain('secret-scope')
  expect(rawBody).not.toContain('"source"')
  expect(rawBody).not.toContain('"reference"')
}

describe('non-visual adapter image fallback', () => {
  it('DeepSeek call sends ordered visible placeholders without opaque references', async () => {
    const capture = requestCapture(jsonResponse())

    await callDeepSeek(
      { model: 'deepseek-v4-pro', messages: MIXED_MESSAGES },
      { apiKey: 'key', fetchImpl: capture.fetchImpl, retry: { maxRetries: 0 } },
    )

    expectSafeFallback(capture.rawBody())
  })

  it('GLM stream sends the same safe text projection', async () => {
    const capture = requestCapture(sseResponse())

    await streamGlm(
      { model: 'glm-5.3', messages: MIXED_MESSAGES },
      { apiKey: 'key', fetchImpl: capture.fetchImpl, retry: { maxRetries: 0 } },
    )

    expectSafeFallback(capture.rawBody())
    expect(JSON.parse(capture.rawBody())).toMatchObject({ stream: true })
  })

  it('keeps a pure-text DeepSeek request byte-for-byte unchanged', async () => {
    const capture = requestCapture(jsonResponse())
    const request = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user' as const, content: 'plain text' }],
    }

    await callDeepSeek(
      request,
      { apiKey: 'key', fetchImpl: capture.fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(capture.rawBody()).toBe(JSON.stringify(request))
  })
})
