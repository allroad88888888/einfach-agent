import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, type ToolContext } from '@einfach-agent/core/tools'
import { viewImageTool } from './view-image'

type ViewImageContext = ToolContext & { viewImage: NonNullable<ToolContext['viewImage']> }

function viewedImage(name = 'cat.png') {
  return {
    image: {
      type: 'image' as const,
      source: { kind: 'inline-base64' as const, data: 'aGVsbG8=' },
      name,
      mimeType: 'image/png',
      byteSize: 5,
      width: 20,
      height: 10,
      detail: 'original' as const,
    },
  }
}

function makeCtx(overrides: Partial<ViewImageContext> = {}): ViewImageContext {
  return {
    sessionId: 'test-session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    viewImage: vi.fn(async () => viewedImage()),
    ...overrides,
  }
}

describe('view_image tool', () => {
  it('defaults omitted detail to low and separates metadata from model image content', async () => {
    const viewImage = vi.fn(async () => viewedImage('dashboard.png'))
    const registry = createToolRegistry()
    registry.register(viewImageTool)
    const result = await registry.run(
      'view_image',
      { path: '  images/dashboard.png  ' },
      makeCtx({ viewImage }),
    )

    expect(viewImage).toHaveBeenCalledWith({ path: 'images/dashboard.png', detail: 'low' })
    expect(viewImageTool.inputSchema).toMatchObject({
      properties: { detail: { enum: ['low', 'high'], default: 'low' } },
      required: ['path'],
    })
    expect(result).toEqual({
      ok: true,
      data: {
        path: 'images/dashboard.png',
        detail: 'low',
        name: 'dashboard.png',
        mimeType: 'image/png',
        byteSize: 5,
        width: 20,
        height: 10,
      },
      modelContent: [viewedImage('dashboard.png').image],
    })
  })

  it('forwards high exactly for detailed inspection', async () => {
    const viewImage = vi.fn(async () => viewedImage('chart.png'))
    await viewImageTool.execute({ path: 'chart.png', detail: 'high' }, makeCtx({ viewImage }))
    expect(viewImage).toHaveBeenCalledWith({ path: 'chart.png', detail: 'high' })
  })

  it('rejects invalid paths and detail before calling the runtime', async () => {
    const viewImage = vi.fn(async () => viewedImage())
    const ctx = makeCtx({ viewImage })

    await expect(viewImageTool.execute({ path: ' ' }, ctx)).resolves.toMatchObject({
      ok: false,
      code: 'VIEW_IMAGE_INVALID_INPUT',
    })
    await expect(viewImageTool.execute({ path: 'image.png', detail: 'original' }, ctx)).resolves.toMatchObject({
      ok: false,
      code: 'VIEW_IMAGE_INVALID_INPUT',
    })
    expect(viewImage).not.toHaveBeenCalled()
  })

  it('fails closed when the host has no viewImage capability', async () => {
    const ctx = makeCtx()
    delete (ctx as Partial<ViewImageContext>).viewImage
    await expect(viewImageTool.execute({ path: 'image.png' }, ctx)).resolves.toEqual({
      ok: false,
      error: 'view_image unavailable: ctx.viewImage is not configured',
      code: 'VIEW_IMAGE_UNAVAILABLE',
      retryable: false,
    })
  })

  it('rejects malformed runtime results without exposing their object shape', async () => {
    const result = await viewImageTool.execute(
      { path: 'image.png' },
      makeCtx({ viewImage: vi.fn(async () => ({ content: 'text' } as never)) }),
    )
    expect(result).toEqual({
      ok: false,
      error: 'view_image failed: vision runtime returned an invalid response',
      code: 'VIEW_IMAGE_INVALID_RESPONSE',
      retryable: false,
    })
  })

  it('rejects invalid image dimensions and detail from the runtime', async () => {
    const invalid = viewedImage().image
    const result = await viewImageTool.execute(
      { path: 'image.png' },
      makeCtx({ viewImage: vi.fn(async () => ({
        image: { ...invalid, width: -1, detail: 'private' },
      } as never)) }),
    )
    expect(result).toMatchObject({ ok: false, code: 'VIEW_IMAGE_INVALID_RESPONSE' })
  })

  it('does not expose arbitrary runtime errors', async () => {
    const result = await viewImageTool.execute(
      { path: 'image.png' },
      makeCtx({ viewImage: vi.fn(async () => { throw { secret: 'file-api-secret' } }) }),
    )
    expect(result).toEqual({
      ok: false,
      error: 'view_image failed: vision runtime could not inspect the image',
      code: 'VIEW_IMAGE_FAILED',
      retryable: true,
    })
  })
})
