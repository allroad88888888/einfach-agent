import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostBridgeMock } from './hostBridgeMock.testHarness'

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./hostBridge', () => hostBridgeMock(async () => host.invoke))

import { readWorkspaceImage } from './workspaceImageRead'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readWorkspaceImage bridge', () => {
  it('转换宿主参数并收窄受限图片结果', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    host.invoke.mockResolvedValue({
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      filename: 'shot.png',
      sizeBytes: bytes.byteLength,
    })

    await expect(readWorkspaceImage({
      path: 'shot.png',
      maxBytes: 1024,
      workspaceRoot: '/workspace',
      allowExternalPaths: true,
    })).resolves.toEqual({
      ok: true,
      data: {
        base64: bytes.toString('base64'),
        mimeType: 'image/png',
        filename: 'shot.png',
        sizeBytes: bytes.byteLength,
      },
    })
    expect(host.invoke).toHaveBeenCalledWith('read_workspace_image', {
      path: 'shot.png',
      max_bytes: 1024,
      workspace_root: '/workspace',
      allow_external_paths: true,
    })
  })

  it.each([
    { base64: 'AAAA', mimeType: 'application/octet-stream', filename: 'a', sizeBytes: 3 },
    { base64: 'not-base64', mimeType: 'image/png', filename: 'a', sizeBytes: 3 },
    { base64: 'AAAA', mimeType: 'image/png', filename: 'a', sizeBytes: 2 },
    { base64: 'AAAA', mimeType: 'image/png', filename: 'a', sizeBytes: 3 },
  ])('拒绝扩成任意二进制通道的宿主响应 %#', async (response) => {
    host.invoke.mockResolvedValue(response)
    await expect(readWorkspaceImage({ path: 'a' })).resolves.toEqual({
      ok: false,
      error: 'read_workspace_image returned an invalid response',
    })
  })

  it('拒绝超过调用方 maxBytes 的远程 host payload', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    host.invoke.mockResolvedValue({
      base64: bytes.toString('base64'),
      mimeType: 'image/png',
      filename: 'large.png',
      sizeBytes: bytes.byteLength,
    })

    await expect(readWorkspaceImage({ path: 'large.png', maxBytes: 7 })).resolves.toEqual({
      ok: false,
      error: 'read_workspace_image returned an invalid response',
    })
  })

  it.each([
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/webp', Buffer.from('RIFF\x04\x00\x00\x00WEBPdata', 'binary')],
  ] as const)('接受 MIME 与 %s 魔数一致的 payload', async (mimeType, bytes) => {
    host.invoke.mockResolvedValue({
      base64: bytes.toString('base64'),
      mimeType,
      filename: 'image.bin',
      sizeBytes: bytes.byteLength,
    })

    await expect(readWorkspaceImage({ path: 'image.bin' })).resolves.toMatchObject({
      ok: true,
      data: { mimeType, sizeBytes: bytes.byteLength },
    })
  })

  it('拒绝超过 20 MiB 硬上限的伪造 sizeBytes，再进行解码', async () => {
    host.invoke.mockResolvedValue({
      base64: 'AAAA',
      mimeType: 'image/png',
      filename: 'huge.png',
      sizeBytes: 20 * 1024 * 1024 + 1,
    })

    await expect(readWorkspaceImage({ path: 'huge.png' })).resolves.toMatchObject({ ok: false })
  })

  it('拒绝 MIME 与实际图片魔数不一致的 host payload', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    host.invoke.mockResolvedValue({
      base64: jpeg.toString('base64'),
      mimeType: 'image/png',
      filename: 'mislabeled.png',
      sizeBytes: jpeg.byteLength,
    })

    await expect(readWorkspaceImage({ path: 'mislabeled.png' })).resolves.toMatchObject({ ok: false })
  })

  it('把宿主错误收成可读失败结果', async () => {
    host.invoke.mockRejectedValue(new Error('image exceeds limit'))
    await expect(readWorkspaceImage({ path: 'huge.png' })).resolves.toEqual({
      ok: false,
      error: 'read_workspace_image failed: image exceeds limit',
    })
  })
})
