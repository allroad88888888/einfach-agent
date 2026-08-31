import { afterEach, describe, expect, it, vi } from 'vitest'

const imageBridge = vi.hoisted(() => ({ readWorkspaceImage: vi.fn() }))
vi.mock('./workspaceImageRead', () => imageBridge)

import { buildToolContext } from './toolContext'
import { seedSession } from './toolContext.workspaceRoot.testHarness'

afterEach(() => {
  vi.clearAllMocks()
})

function context(sessionId: string, signal = new AbortController().signal) {
  return buildToolContext({
    sessionId,
    runId: 'r',
    signal,
    callId: 'image-call',
    toolName: 'view_image',
  })
}

describe('ToolContext.readWorkspaceImage', () => {
  it('注入会话 workspace root，并只为 Auto 注入外部只读权限', async () => {
    imageBridge.readWorkspaceImage.mockResolvedValue({
      ok: true,
      data: { base64: 'AA==', mimeType: 'image/png', filename: 'a.png', sizeBytes: 1 },
    })
    seedSession('image-auto', '/session/root', 'auto')

    await expect(context('image-auto').readWorkspaceImage!({
      path: '/other/a.png',
      allowExternalPaths: false,
    })).resolves.toMatchObject({ mimeType: 'image/png' })
    expect(imageBridge.readWorkspaceImage).toHaveBeenCalledWith({
      path: '/other/a.png',
      workspaceRoot: '/session/root',
      allowExternalPaths: true,
    })
  })

  it('非 Auto 会话移除调用方伪造的外部路径权限', async () => {
    imageBridge.readWorkspaceImage.mockResolvedValue({
      ok: true,
      data: { base64: 'AA==', mimeType: 'image/png', filename: 'a.png', sizeBytes: 1 },
    })
    seedSession('image-confirm', '/session/root', 'confirm')

    await context('image-confirm').readWorkspaceImage!({
      path: '/other/a.png',
      allowExternalPaths: true,
    })
    expect(imageBridge.readWorkspaceImage).toHaveBeenCalledWith({
      path: '/other/a.png',
      workspaceRoot: '/session/root',
    })
  })

  it('调用前已取消时不触发宿主读取', async () => {
    seedSession('image-aborted', '/session/root', 'auto')
    const controller = new AbortController()
    controller.abort()

    await expect(context('image-aborted', controller.signal).readWorkspaceImage!({
      path: 'a.png',
    })).rejects.toThrow('stale')
    expect(imageBridge.readWorkspaceImage).not.toHaveBeenCalled()
  })

  it('宿主读取期间取消时丢弃迟到结果', async () => {
    seedSession('image-late', '/session/root', 'auto')
    const controller = new AbortController()
    let finish!: (value: unknown) => void
    imageBridge.readWorkspaceImage.mockImplementation(() => new Promise((resolve) => {
      finish = resolve
    }))

    const pending = context('image-late', controller.signal).readWorkspaceImage!({ path: 'a.png' })
    controller.abort()
    finish({
      ok: true,
      data: { base64: 'AA==', mimeType: 'image/png', filename: 'a.png', sizeBytes: 1 },
    })

    await expect(pending).rejects.toThrow('stale')
  })
})
