import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, type ToolContext } from '@einfach-agent/core/tools'
import { viewImageTool } from './view-image'

type ViewImageContext = ToolContext & { viewImage: NonNullable<ToolContext['viewImage']> }

function makeCtx(overrides: Partial<ViewImageContext> = {}): ViewImageContext {
  return {
    sessionId: 'test-session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    viewImage: vi.fn(async () => ({ content: 'A cat on a chair.', model: 'vision-test' })),
    ...overrides,
  }
}

describe('view_image tool', () => {
  it('defaults omitted detail to low and returns only text content plus model', async () => {
    const viewImage = vi.fn(async () => ({
      content: 'A screenshot of a dashboard.',
      model: 'vision-model',
      internal: { fileId: 'file-api-secret' },
    }))
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
      data: { content: 'A screenshot of a dashboard.', model: 'vision-model' },
    })
  })

  it('forwards high exactly for detailed inspection', async () => {
    const viewImage = vi.fn(async () => ({ content: 'Small labels are readable.', model: 'vision-test' }))
    await viewImageTool.execute({ path: 'chart.png', detail: 'high' }, makeCtx({ viewImage }))
    expect(viewImage).toHaveBeenCalledWith({ path: 'chart.png', detail: 'high' })
  })

  it('rejects invalid paths and detail before calling the runtime', async () => {
    const viewImage = vi.fn(async () => ({ content: 'ignored', model: 'vision-test' }))
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
