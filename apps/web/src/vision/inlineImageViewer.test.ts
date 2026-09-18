import { describe, expect, it, vi } from 'vitest'
import type { ViewImageCapabilityContext } from '@einfach-agent/core'
import { createInlineImageViewer } from './inlineImageViewer'
import { asBase64, pngBytes } from '../imageInput/staticImagePolicy.testFixtures'

const sourceBytes = pngBytes(400, 300)
const source = {
  base64: asBase64(sourceBytes),
  mimeType: 'image/png' as const,
  filename: 'screen.png',
  sizeBytes: sourceBytes.length,
}

function context(signal = new AbortController().signal): ViewImageCapabilityContext {
  return { signal, assertFresh: vi.fn(), readWorkspaceImage: vi.fn().mockResolvedValue(source) }
}

describe('inline viewImage runtime', () => {
  it('reads, resizes, and returns Base64 without invoking a model', async () => {
    const resizeImage = vi.fn().mockResolvedValue({
      data: new Blob(['small'], { type: 'image/png' }),
      name: 'screen.png', mimeType: 'image/png', width: 512, height: 256,
    })
    const viewer = createInlineImageViewer({ resizeImage })
    const capabilityContext = context()

    await expect(viewer({ path: 'screen.png', detail: 'low' }, capabilityContext))
      .resolves.toEqual({
        image: {
          type: 'image',
          source: { kind: 'inline-base64', data: 'c21hbGw=' },
          name: 'screen.png',
          mimeType: 'image/png',
          byteSize: 5,
          width: 512,
          height: 256,
          detail: 'original',
        },
      })
    expect(capabilityContext.readWorkspaceImage).toHaveBeenCalledWith({
      path: 'screen.png', maxBytes: 10 * 1024 * 1024,
    })
    expect(resizeImage).toHaveBeenCalledWith(source, 'low', capabilityContext.signal)
    expect(capabilityContext.assertFresh).toHaveBeenCalledTimes(3)
  })

  it('keeps lifecycle errors and redacts host read failures', async () => {
    const viewer = createInlineImageViewer()
    const lifecycleError = new DOMException('aborted', 'AbortError')
    await expect(viewer({ path: 'screen.png', detail: 'low' }, {
      ...context(), readWorkspaceImage: vi.fn().mockRejectedValue(lifecycleError),
    })).rejects.toBe(lifecycleError)

    const failure = await viewer({ path: '/outside/private.png', detail: 'high' }, {
      ...context(), readWorkspaceImage: vi.fn().mockRejectedValue(new Error('secret path')),
    }).catch((error: unknown) => error)
    expect(failure).toEqual(new Error('当前宿主不支持读取图片'))
  })

  it('rejects stale output after preprocessing', async () => {
    const assertFresh = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('stale') })
    const viewer = createInlineImageViewer({
      resizeImage: vi.fn().mockResolvedValue({
        data: new Blob(['small'], { type: 'image/png' }),
        name: 'screen.png', mimeType: 'image/png', width: 400, height: 300,
      }),
    })

    await expect(viewer({ path: 'screen.png', detail: 'high' }, {
      ...context(), assertFresh,
    })).rejects.toThrow('stale')
  })
})
