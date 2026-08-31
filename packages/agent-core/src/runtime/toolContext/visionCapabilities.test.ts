import { afterEach, describe, expect, it, vi } from 'vitest'

const imageBridge = vi.hoisted(() => ({ readWorkspaceImage: vi.fn() }))
vi.mock('../workspaceImageRead', () => imageBridge)

import { createCoreInstance } from '../core/coreInstance'
import { buildToolContext } from '../toolContext'
import { seedSession } from '../toolContext.workspaceRoot.testHarness'

afterEach(() => {
  vi.clearAllMocks()
})

function imageResult() {
  return { base64: 'iVBORw0KGgo=', mimeType: 'image/png' as const, filename: 'screen.png', sizeBytes: 8 }
}

describe('ToolContext viewImage vision capability', () => {
  it('未装配 app port 时不暴露 viewImage', () => {
    const core = createCoreInstance()
    seedSession('vision-none', '/workspace', 'confirm', core)
    const ctx = buildToolContext({
      sessionId: 'vision-none', runId: 'r', signal: new AbortController().signal,
      callId: 'call', toolName: 'view_image', core,
    })

    expect(ctx.viewImage).toBeUndefined()
  })

  it('只向 app port 提供 signal 与受管图片读取，并注入 workspace 权限', async () => {
    imageBridge.readWorkspaceImage.mockResolvedValue({ ok: true, data: imageResult() })
    const port = vi.fn(async (_input, capabilityContext) => {
      expect(Object.keys(capabilityContext).sort()).toEqual([
        'assertFresh', 'readWorkspaceImage', 'signal',
      ])
      const image = await capabilityContext.readWorkspaceImage({
        path: '/outside/screen.png',
        allowExternalPaths: false,
      })
      return { content: image.filename, model: 'vision-model' }
    })
    const core = createCoreInstance({ config: { viewImage: port } })
    seedSession('vision-auto', '/workspace', 'auto', core)
    const signal = new AbortController().signal
    const ctx = buildToolContext({
      sessionId: 'vision-auto', runId: 'r', signal, callId: 'call', toolName: 'view_image', core,
    })

    await expect(ctx.viewImage!({ path: '/outside/screen.png', detail: 'low' }))
      .resolves.toEqual({ content: 'screen.png', model: 'vision-model' })
    expect(port).toHaveBeenCalledWith(
      { path: '/outside/screen.png', detail: 'low' },
      expect.objectContaining({
        signal,
        assertFresh: expect.any(Function),
        readWorkspaceImage: expect.any(Function),
      }),
    )
    expect(imageBridge.readWorkspaceImage).toHaveBeenCalledWith({
      path: '/outside/screen.png', workspaceRoot: '/workspace', allowExternalPaths: true,
    })
  })

  it('stale run 在 app port 前拒绝，调用中取消会丢弃迟到结果', async () => {
    let finish!: () => void
    const port = vi.fn(() => new Promise<{ content: string; model: string }>((resolve) => {
      finish = () => resolve({ content: 'late', model: 'vision-model' })
    }))
    const core = createCoreInstance({ config: { viewImage: port } })
    seedSession('vision-stale', '/workspace', 'confirm', core)
    const stale = buildToolContext({
      sessionId: 'vision-stale', runId: 'old', signal: new AbortController().signal,
      callId: 'call', toolName: 'view_image', core,
    })
    await expect(stale.viewImage!({ path: 'a.png', detail: 'high' })).rejects.toThrow('stale')
    expect(port).not.toHaveBeenCalled()

    const controller = new AbortController()
    const live = buildToolContext({
      sessionId: 'vision-stale', runId: 'r', signal: controller.signal,
      callId: 'call', toolName: 'view_image', core,
    })
    const pending = live.viewImage!({ path: 'a.png', detail: 'high' })
    controller.abort()
    finish()
    await expect(pending).rejects.toThrow('stale')
  })

  it('宿主图片读取失败时向调用方返回明确错误', async () => {
    imageBridge.readWorkspaceImage.mockResolvedValue({
      ok: false,
      error: 'read_workspace_image：当前宿主未提供命令桥',
    })
    const core = createCoreInstance({
      config: {
        viewImage: async (input, context) => ({
          content: (await context.readWorkspaceImage({ path: input.path })).filename,
          model: 'never',
        }),
      },
    })
    seedSession('vision-static', '/workspace', 'confirm', core)
    const ctx = buildToolContext({
      sessionId: 'vision-static', runId: 'r', signal: new AbortController().signal,
      callId: 'call', toolName: 'view_image', core,
    })

    await expect(ctx.viewImage!({ path: 'a.png', detail: 'low' }))
      .rejects.toThrow('当前宿主未提供命令桥')
  })
})
