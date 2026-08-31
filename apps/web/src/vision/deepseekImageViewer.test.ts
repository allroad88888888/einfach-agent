import { describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_VISION_MODEL } from '@einfach-agent/ai'
import type { ViewImageCapabilityContext } from '@einfach-agent/core'
import { createDeepSeekImageViewer } from './deepseekImageViewer'
import { resizeVisionImage, type VisionResizePlatform } from './resizeVisionImage'
import {
  animatedWebpBytes,
  asBase64,
  malformedReviewContainers,
  pngBytes,
  webpLosslessBytes,
} from '../imageInput/staticImagePolicy.testFixtures'

const sourceBytes = pngBytes(400, 300)
const source = {
  base64: asBase64(sourceBytes),
  mimeType: 'image/png' as const,
  filename: 'screen.png',
  sizeBytes: sourceBytes.length,
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function context(signal = new AbortController().signal): ViewImageCapabilityContext {
  return { signal, assertFresh: vi.fn(), readWorkspaceImage: vi.fn().mockResolvedValue(source) }
}

describe('DeepSeek viewImage runtime', () => {
  it('只发固定模型的单轮无工具请求，并在成功后删除文件', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.endsWith('/files')) return json({ id: 'file-api-temporary' })
      return json({
        model: 'deepseek-v4-flash-vision-exp-actual',
        choices: [{ message: { role: 'assistant', content: '图中有一个设置面板。' } }],
      })
    }) as typeof fetch
    const resizeImage = vi.fn().mockResolvedValue({
      data: new Blob(['small'], { type: 'image/png' }),
      name: 'screen.png', mimeType: 'image/png', width: 512, height: 256,
    })
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl, resizeImage })
    const capabilityContext = context()

    await expect(viewer({ path: 'screen.png', detail: 'low' }, capabilityContext)).resolves.toEqual({
      content: '图中有一个设置面板。',
      model: 'deepseek-v4-flash-vision-exp-actual',
    })
    expect(resizeImage).toHaveBeenCalledWith(source, 'low', capabilityContext.signal)
    const chat = requests.find(({ url }) => url.endsWith('/chat/completions'))!
    const body = JSON.parse(String(chat.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: DEEPSEEK_VISION_MODEL, stream: false })
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: expect.any(String) },
        { type: 'file', file_id: 'file-api-temporary' },
      ],
    }])
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(JSON.stringify(body)).not.toContain('detail')
    expect(requests.at(-1)).toMatchObject({
      url: 'https://api.deepseek.com/files/file-api-temporary',
      init: { method: 'DELETE' },
    })
  })

  it('视觉响应失败仍 best-effort 删除，错误不暴露 key 或 file id', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.method === 'DELETE') throw new Error('cleanup unavailable')
      if (url.endsWith('/files')) return json({ id: 'file-api-sensitive-id' })
      return json({ model: DEEPSEEK_VISION_MODEL, choices: [] })
    }) as typeof fetch
    const viewer = createDeepSeekImageViewer({
      apiKey: 'secret-key',
      fetchImpl,
      resizeImage: vi.fn().mockResolvedValue({
        data: new Blob(['raw'], { type: 'image/png' }), name: 'screen.png', mimeType: 'image/png',
        width: 400, height: 300,
      }),
    })

    const error = await viewer({ path: 'screen.png', detail: 'high' }, context()).catch((value) => value)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('视觉模型调用失败，请稍后重试')
    expect(error.message).not.toContain('secret-key')
    expect(error.message).not.toContain('file-api-sensitive-id')
    expect(calls).toContain('DELETE https://api.deepseek.com/files/file-api-sensitive-id')
  })

  it('隔离调用取消后仍删除已上传文件并透传 AbortError', async () => {
    const controller = new AbortController()
    const deleted = vi.fn()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted()
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/files')) return json({ id: 'file-api-cancelled' })
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch
    const viewer = createDeepSeekImageViewer({
      apiKey: 'secret-key',
      fetchImpl,
      resizeImage: vi.fn().mockResolvedValue({
        data: new Blob(['raw'], { type: 'image/png' }), name: 'screen.png', mimeType: 'image/png',
        width: 400, height: 300,
      }),
    })

    await expect(viewer(
      { path: 'screen.png', detail: 'high' },
      context(controller.signal),
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(deleted).toHaveBeenCalledOnce()
  })

  it('无图片读取宿主返回明确固定错误且不透传 bridge 文案', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl })
    const capabilityContext: ViewImageCapabilityContext = {
      signal: new AbortController().signal,
      assertFresh: vi.fn(),
      readWorkspaceImage: vi.fn().mockRejectedValue(
        new Error('read_workspace_image：当前宿主未提供命令桥'),
      ),
    }

    await expect(viewer({ path: 'screen.png', detail: 'low' }, capabilityContext))
      .rejects.toThrow('当前宿主不支持读取图片')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('host 读取错误固定脱敏，不泄露外部路径或底层文本', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const resizeImage = vi.fn()
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl, resizeImage })
    const capabilityContext: ViewImageCapabilityContext = {
      signal: new AbortController().signal,
      assertFresh: vi.fn(),
      readWorkspaceImage: vi.fn().mockRejectedValue(
        new Error('cannot read /outside/private/secret.png'),
      ),
    }

    const error = await viewer(
      { path: '/outside/private/secret.png', detail: 'low' },
      capabilityContext,
    ).catch((value) => value)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('当前宿主不支持读取图片')
    expect(error.message).not.toContain('/outside/private/secret.png')
    expect(error.message).not.toContain('cannot read')
    expect(resizeImage).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    new DOMException('aborted', 'AbortError'),
    new Error('stale'),
  ])('读取阶段保留生命周期错误 %#', async (lifecycleError) => {
    const fetchImpl = vi.fn() as typeof fetch
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl })

    const error = await viewer({ path: 'screen.png', detail: 'low' }, {
      ...context(),
      readWorkspaceImage: vi.fn().mockRejectedValue(lifecycleError),
    }).catch((value) => value)
    expect(error).toBe(lifecycleError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('low WebP 编码回退为 PNG 时不调用 Files API', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const fallbackPlatform: VisionResizePlatform = {
      decode: vi.fn().mockResolvedValue({ width: 1024, height: 512, close: vi.fn() }),
      encode: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
    }
    const viewer = createDeepSeekImageViewer({
      apiKey: 'secret-key',
      fetchImpl,
      resizeImage: (input, detail, signal) =>
        resizeVisionImage(input, detail, signal, fallbackPlatform),
    })
    const webpSource = {
      ...source,
      base64: asBase64(webpLosslessBytes(1024, 512)),
      mimeType: 'image/webp' as const,
      filename: 'screen.webp',
      sizeBytes: webpLosslessBytes(1024, 512).length,
    }

    await expect(viewer({ path: 'screen.webp', detail: 'low' }, {
      ...context(),
      readWorkspaceImage: vi.fn().mockResolvedValue(webpSource),
    })).rejects.toThrow('图片预处理失败，无法进行视觉读取')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('预处理后发现 stale 时不上传并保留 stale 语义', async () => {
    const fetchImpl = vi.fn() as typeof fetch
    const assertFresh = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('stale') })
    const viewer = createDeepSeekImageViewer({
      apiKey: 'secret-key',
      fetchImpl,
      resizeImage: vi.fn().mockResolvedValue({
        data: new Blob(['raw'], { type: 'image/png' }), name: 'screen.png', mimeType: 'image/png',
        width: 400, height: 300,
      }),
    })

    await expect(viewer({ path: 'screen.png', detail: 'low' }, {
      ...context(),
      assertFresh,
    })).rejects.toThrow('stale')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['low', 'APNG', pngBytes(400, 300, true), 'image/png'],
    ['high', 'APNG', pngBytes(400, 300, true), 'image/png'],
    ['low', 'WebP ANIM', animatedWebpBytes(400, 300, 'ANIM'), 'image/webp'],
    ['high', 'WebP ANIM', animatedWebpBytes(400, 300, 'ANIM'), 'image/webp'],
    ['low', 'WebP VP8X flag', animatedWebpBytes(400, 300, 'VP8X'), 'image/webp'],
    ['high', 'WebP VP8X flag', animatedWebpBytes(400, 300, 'VP8X'), 'image/webp'],
    ['high', '8192×8192', webpLosslessBytes(8192, 8192), 'image/webp'],
  ] as const)('%s %s 在 Files/chat 前 fail-closed', async (detail, _label, bytes, mimeType) => {
    const fetchImpl = vi.fn() as typeof fetch
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl })
    const filename = mimeType === 'image/png' ? 'unsafe.png' : 'unsafe.webp'

    await expect(viewer({ path: filename, detail }, {
      ...context(),
      readWorkspaceImage: vi.fn().mockResolvedValue({
        base64: asBase64(bytes), mimeType, filename, sizeBytes: bytes.length,
      }),
    })).rejects.toThrow('图片预处理失败，无法进行视觉读取')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(malformedReviewContainers)('$label high 在 Files/chat 前 fail-closed', async ({
    bytes,
    mimeType,
  }) => {
    const fetchImpl = vi.fn() as typeof fetch
    const viewer = createDeepSeekImageViewer({ apiKey: 'secret-key', fetchImpl })
    const filename = mimeType === 'image/jpeg' ? 'broken.jpg'
      : mimeType === 'image/png' ? 'broken.png' : 'broken.webp'

    await expect(viewer({ path: filename, detail: 'high' }, {
      ...context(),
      readWorkspaceImage: vi.fn().mockResolvedValue({
        base64: asBase64(bytes), mimeType, filename, sizeBytes: bytes.length,
      }),
    })).rejects.toThrow('图片预处理失败，无法进行视觉读取')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
