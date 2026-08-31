import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from './common/tempWorkspace.testHarness'
import { MAX_WORKSPACE_IMAGE_BYTES, readWorkspaceImage } from './workspace-image-read'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const WEBP = Buffer.from('RIFF\x04\x00\x00\x00WEBPdata', 'binary')
const runExecFile = promisify(execFile)

async function releaseBlockedFifo(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | constants.O_NONBLOCK)
  await handle.close()
}

describe('readWorkspaceImage', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace()
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it.each([
    ['photo.bin', JPEG, 'image/jpeg'],
    ['diagram.data', PNG, 'image/png'],
    ['render.raw', WEBP, 'image/webp'],
  ] as const)('按魔数读取 %s，不依赖扩展名', async (filename, bytes, mimeType) => {
    await writeFile(join(workspace.root, filename), bytes)

    await expect(readWorkspaceImage({
      path: filename,
      workspace_root: workspace.root,
    })).resolves.toEqual({
      base64: bytes.toString('base64'),
      mimeType,
      filename,
      sizeBytes: bytes.byteLength,
    })
  })

  it('拒绝伪造图片扩展名', async () => {
    await writeFile(join(workspace.root, 'fake.png'), 'not an image')

    await expect(readWorkspaceImage({
      path: 'fake.png',
      workspace_root: workspace.root,
    })).rejects.toThrow('not a supported JPEG, PNG, or WebP image')
  })

  it('拒绝 workspace 越界与 symlink 逃逸，且不泄漏根外真实路径', async () => {
    const external = join(workspace.base, 'outside-secret.png')
    await writeFile(external, PNG)
    await symlink(external, join(workspace.root, 'innocent-link.png'))

    const error = await readWorkspaceImage({
      path: 'innocent-link.png',
      workspace_root: workspace.root,
    }).then(() => undefined, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('escapes workspace root')
    expect((error as Error).message).not.toContain(external)
  })

  it('只有显式 allow_external_paths 才能读取根外图片', async () => {
    const external = join(workspace.base, 'external.png')
    await writeFile(external, PNG)

    await expect(readWorkspaceImage({
      path: external,
      workspace_root: workspace.root,
      allow_external_paths: true,
    })).resolves.toMatchObject({ mimeType: 'image/png', filename: 'external.png' })
  })

  it('resolve 后路径被换成外部 symlink 时拒绝打开或身份复核', async () => {
    const requested = join(workspace.root, 'raced.png')
    const external = join(workspace.base, 'race-secret.png')
    await writeFile(requested, PNG)
    await writeFile(external, JPEG)

    const error = await readWorkspaceImage({
      path: 'raced.png',
      workspace_root: workspace.root,
    }, {
      async afterResolve() {
        await rename(requested, join(workspace.root, 'original.png'))
        await symlink(external, requested)
      },
    }).then(() => undefined, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect(['failed to open requested image', 'requested image changed during access'])
      .toContain((error as Error).message)
    expect((error as Error).message).not.toContain(external)
  })

  it('handle resolver 返回外部最终路径时拒绝，且不再回查 pathname', async () => {
    const external = join(workspace.base, 'handle-secret.png')
    await writeFile(join(workspace.root, 'opened.png'), PNG)

    await expect(readWorkspaceImage({
      path: 'opened.png', workspace_root: workspace.root,
    }, {
      resolveHandlePath: async () => external,
    })).rejects.toThrow('requested image changed during access')
  })

  it('handle resolver 返回内部最终路径时读取原 handle', async () => {
    const requested = join(workspace.root, 'verified.png')
    await writeFile(requested, PNG)

    await expect(readWorkspaceImage({
      path: 'verified.png', workspace_root: workspace.root,
    }, {
      resolveHandlePath: async () => requested,
    })).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('目录由原 handle 的 fstat 拒绝，且不查询 handle path', async () => {
    const resolveHandlePath = vi.fn(async () => workspace.root)

    await expect(readWorkspaceImage({
      path: '.', workspace_root: workspace.root,
    }, { resolveHandlePath })).rejects.toThrow(/^requested image is not a file$/)
    expect(resolveHandlePath).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    '真实 FIFO 无 writer 时在短超时内有界拒绝',
    async () => {
      const fifo = join(workspace.root, 'blocked.png')
      await runExecFile('/usr/bin/mkfifo', [fifo])
      const resolveHandlePath = vi.fn(async () => fifo)
      const read = readWorkspaceImage({
        path: 'blocked.png', workspace_root: workspace.root,
      }, { resolveHandlePath }).then(
        () => ({ status: 'resolved' } as const),
        (error: unknown) => ({ status: 'rejected', error } as const),
      )
      const timedOut = Symbol('timed out')
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), 750)
      })

      const outcome = await Promise.race([read, timeout])
      if (timer) clearTimeout(timer)
      if (outcome === timedOut) {
        await releaseBlockedFifo(fifo)
        await read
        throw new Error('readWorkspaceImage did not reject FIFO within 750ms')
      }
      if (outcome.status !== 'rejected') {
        throw new Error('readWorkspaceImage unexpectedly resolved for FIFO')
      }
      expect(outcome.error).toBeInstanceOf(Error)
      expect((outcome.error as Error).message).toBe('requested image is not a file')
      expect((outcome.error as Error).message).not.toContain(fifo)
      expect(resolveHandlePath).not.toHaveBeenCalled()
    },
  )

  it('Auto 外部 symlink 的目标在 open 前消失时错误不泄漏 canonical 路径', async () => {
    const external = join(workspace.base, 'vanishing-secret.png')
    const alias = join(workspace.root, 'external-alias.png')
    await writeFile(external, PNG)
    await symlink(external, alias)

    const error = await readWorkspaceImage({
      path: 'external-alias.png',
      workspace_root: workspace.root,
      allow_external_paths: true,
    }, {
      afterResolve: () => unlink(external),
    }).then(() => undefined, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('failed to open requested image')
    expect((error as Error).message).not.toContain(external)
  })

  it('Auto 外部 symlink 的 handle 读取失败时错误不泄漏 canonical 路径', async () => {
    const external = join(workspace.base, 'unreadable-secret.png')
    const alias = join(workspace.root, 'unreadable-alias.png')
    await writeFile(external, PNG)
    await symlink(external, alias)

    const error = await readWorkspaceImage({
      path: 'unreadable-alias.png',
      workspace_root: workspace.root,
      allow_external_paths: true,
    }, {
      beforeRead: (handle) => handle.close(),
    }).then(() => undefined, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('failed to read requested image')
    expect((error as Error).message).not.toContain(external)
  })

  it('在读取字节前拒绝超过 20 MiB 的文件', async () => {
    const oversized = join(workspace.root, 'oversized.png')
    await writeFile(oversized, PNG)
    await truncate(oversized, MAX_WORKSPACE_IMAGE_BYTES + 1)

    await expect(readWorkspaceImage({
      path: 'oversized.png',
      workspace_root: workspace.root,
    })).rejects.toThrow(`${MAX_WORKSPACE_IMAGE_BYTES} byte limit`)
  })

  it('拒绝无效或高于全局上限的 max_bytes', async () => {
    await writeFile(join(workspace.root, 'small.png'), PNG)
    await expect(readWorkspaceImage({
      path: 'small.png', workspace_root: workspace.root, max_bytes: PNG.byteLength - 1,
    })).rejects.toThrow(`${PNG.byteLength - 1} byte limit`)
    await expect(readWorkspaceImage({
      path: 'small.png', workspace_root: workspace.root, max_bytes: 0,
    })).rejects.toThrow('positive integer')
    await expect(readWorkspaceImage({
      path: 'small.png',
      workspace_root: workspace.root,
      max_bytes: MAX_WORKSPACE_IMAGE_BYTES + 1,
    })).rejects.toThrow('cannot exceed')
  })
})
