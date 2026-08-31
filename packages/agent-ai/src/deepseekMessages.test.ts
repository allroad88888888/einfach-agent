import { describe, expect, it } from 'vitest'
import { callDeepSeek, DEEPSEEK_VISION_MODEL } from './deepseek'
import { encodeDeepSeekMessages } from './deepseekMessages'
import type { UserImageContentBlock } from './modelProtocol'

function image(overrides: Partial<UserImageContentBlock['source']> = {}): UserImageContentBlock {
  return {
    type: 'image',
    source: {
      kind: 'provider-file',
      provider: 'deepseek',
      scope: 'deepseek:default',
      reference: 'file-api-image_one',
      ...overrides,
    },
    name: 'one.png',
    mimeType: 'image/png',
    byteSize: 10,
  }
}

describe('DeepSeek message projection', () => {
  it('preserves block order and emits file_id without an invalid detail field', () => {
    expect(encodeDeepSeekMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        image(),
        { type: 'text', text: 'after' },
      ],
    }], DEEPSEEK_VISION_MODEL)).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'file', file_id: 'file-api-image_one' },
        { type: 'text', text: 'after' },
      ],
    }])
  })

  it('projects file blocks through the actual non-streaming request path', async () => {
    let body: Record<string, unknown> | undefined

    await callDeepSeek(
      { model: DEEPSEEK_VISION_MODEL, messages: [{ role: 'user', content: [image()] }] },
      {
        apiKey: 'key',
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(body?.messages).toEqual([{
      role: 'user',
      content: [{ type: 'file', file_id: 'file-api-image_one' }],
    }])
    expect(JSON.stringify(body)).not.toContain('detail')
  })

  it('retains the existing placeholder behavior for non-visual DeepSeek models', async () => {
    let body: Record<string, unknown> | undefined

    await callDeepSeek(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: [image()] }] },
      {
        apiKey: 'key',
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        },
        retry: { maxRetries: 0 },
      },
    )

    expect(body?.messages).toEqual([{
      role: 'user',
      content: '[用户上传了图片 one.png（image/png），当前模型看不到图片内容]',
    }])
  })

  it.each([
    ['foreign provider', image({ provider: 'kimi' }), /cannot consume/],
    ['wrong scope', image({ scope: 'deepseek:other' }), /official API scope/],
    ['Kimi URI', image({ reference: 'ms:\/\/file-one' }), /file-api-\*/],
    ['path-like id', image({ reference: 'file-api-..\/secret' }), /file-api-\*/],
  ])('rejects %s references', (_label, block, error) => {
    expect(() => encodeDeepSeekMessages(
      [{ role: 'user', content: [block] }],
      DEEPSEEK_VISION_MODEL,
    )).toThrow(error)
  })

  it('does not enable file projection for an unverified future model', () => {
    expect(() => encodeDeepSeekMessages(
      [{ role: 'user', content: [image()] }],
      'deepseek-future',
    )).toThrow(/no verified image input protocol/)
  })
})
