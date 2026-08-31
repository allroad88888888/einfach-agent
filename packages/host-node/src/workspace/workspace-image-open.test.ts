import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  openWorkspaceImageHandle,
  type WorkspaceImageOpenDependencies,
} from './workspace-image-open'

function fakeHandle(options: { isFile?: boolean; statError?: Error } = {}) {
  const close = vi.fn(async () => {})
  const stat = vi.fn(async () => {
    if (options.statError) throw options.statError
    return { isFile: () => options.isFile ?? true }
  })
  return {
    close,
    handle: { close, stat } as unknown as FileHandle,
    stat,
  }
}

function dependencies(
  handle: FileHandle,
  overrides: Partial<WorkspaceImageOpenDependencies> = {},
): WorkspaceImageOpenDependencies {
  return {
    platform: 'linux',
    open: vi.fn(async () => handle),
    ...overrides,
  }
}

describe('openWorkspaceImageHandle', () => {
  it('在 pathname open 前拒绝不支持的平台', async () => {
    const { handle } = fakeHandle()
    const open = vi.fn(async () => handle)

    await expect(openWorkspaceImageHandle('/outside/secret.png', {
      platform: 'win32',
      open,
    })).rejects.toThrow(/^workspace image reads are unavailable on this platform$/)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['linux', 'darwin'] as const)('%s 使用 no-follow 与 non-blocking flags', async (platform) => {
    const { handle, stat } = fakeHandle()
    const open = vi.fn(async () => handle)

    await expect(openWorkspaceImageHandle('/workspace/image.png', {
      platform,
      open,
    })).resolves.toMatchObject({ handle })
    expect(open).toHaveBeenCalledWith(
      '/workspace/image.png',
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    expect(stat).toHaveBeenCalledWith({ bigint: true })
  })

  it.each(['FIFO', 'socket', 'device', 'directory'])('原 handle 的 fstat 拒绝 %s', async () => {
    const { close, handle } = fakeHandle({ isFile: false })

    await expect(openWorkspaceImageHandle(
      '/outside/secret.png',
      dependencies(handle),
    )).rejects.toThrow(/^requested image is not a file$/)
    expect(close).toHaveBeenCalledOnce()
  })

  it('fstat 失败时返回稳定错误且不透传底层异常', async () => {
    const { close, handle } = fakeHandle({ statError: new Error('/outside/secret.png') })

    await expect(openWorkspaceImageHandle(
      '/outside/secret.png',
      dependencies(handle),
    )).rejects.toThrow(/^requested image changed during access$/)
    expect(close).toHaveBeenCalledOnce()
  })
})
