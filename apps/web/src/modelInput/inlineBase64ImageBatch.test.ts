import { describe, expect, it } from 'vitest'
import { OPENAI_COMPAT_BASE64_IMAGE_INPUT } from '@einfach-agent/ai'
import { prepareInlineBase64ImageBatch } from './inlineBase64ImageBatch'

function options(signal = new AbortController().signal) {
  return { capability: OPENAI_COMPAT_BASE64_IMAGE_INPUT, signal }
}

describe('inline base64 image preparation', () => {
  it('encodes bytes without changing image metadata', async () => {
    const blocks = await prepareInlineBase64ImageBatch([{
      data: new Blob(['hello'], { type: 'image/png' }),
      name: 'sample.png',
      mimeType: 'image/png',
      width: 20,
      height: 10,
    }], options())

    expect(blocks).toEqual([{
      type: 'image',
      source: { kind: 'inline-base64', data: 'aGVsbG8=' },
      name: 'sample.png',
      mimeType: 'image/png',
      byteSize: 5,
      width: 20,
      height: 10,
    }])
  })

  it('fails with AbortError before reading an aborted batch', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareInlineBase64ImageBatch([{
      data: new Blob(['hello']), name: 'sample.png', mimeType: 'image/png',
    }], options(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('revalidates against the active capability before allocating base64', async () => {
    const capability = {
      ...OPENAI_COMPAT_BASE64_IMAGE_INPUT,
      limits: { ...OPENAI_COMPAT_BASE64_IMAGE_INPUT.limits, maxBytesPerImage: 4 },
    } as const
    await expect(prepareInlineBase64ImageBatch([{
      data: new Blob(['hello'], { type: 'image/png' }),
      name: 'sample.png', mimeType: 'image/png', width: 20, height: 10,
    }], { capability, signal: new AbortController().signal }))
      .rejects.toThrow('per-image byte limit')
  })
})
