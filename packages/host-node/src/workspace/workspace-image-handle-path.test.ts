import { open, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from './common/tempWorkspace.testHarness'
import {
  resolveWorkspaceImageHandlePath,
  type WorkspaceImageHandlePathDependencies,
} from './workspace-image-handle-path'

function dependencies(
  overrides: Partial<WorkspaceImageHandlePathDependencies> = {},
): WorkspaceImageHandlePathDependencies {
  return {
    platform: 'linux',
    pid: 123,
    realpath: vi.fn(async () => '/workspace/image.png'),
    execFile: vi.fn(async () => ''),
    ...overrides,
  }
}

describe('resolveWorkspaceImageHandlePath', () => {
  it('Linux 只解析当前进程的数字 fd link', async () => {
    const readlink = vi.fn(async () => '/workspace/image.png')

    await expect(resolveWorkspaceImageHandlePath(17, dependencies({ realpath: readlink })))
      .resolves.toBe('/workspace/image.png')
    expect(readlink).toHaveBeenCalledWith('/proc/self/fd/17')
  })

  it.each([
    '/workspace/image.png (deleted)',
    'relative/image.png',
    '/workspace/name\nother.png',
  ])('Linux 对不可靠 handle path fail-closed: %j', async (value) => {
    await expect(resolveWorkspaceImageHandlePath(4, dependencies({
      realpath: async () => value,
    }))).rejects.toThrow('cannot verify opened image path')
  })

  it('Linux 的 fd link 查询失败时不透传底层错误', async () => {
    await expect(resolveWorkspaceImageHandlePath(4, dependencies({
      realpath: async () => { throw new Error('/outside/secret.png') },
    }))).rejects.toThrow(/^cannot verify opened image path$/)
  })

  it('macOS 只调用固定 lsof 与固定/数字参数并严格解析唯一记录', async () => {
    const execute = vi.fn(async () => 'p123\nf8\nn/workspace/image.png\n')

    await expect(resolveWorkspaceImageHandlePath(8, dependencies({
      platform: 'darwin',
      execFile: execute,
    }))).resolves.toBe('/workspace/image.png')
    expect(execute).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      ['-a', '-p', '123', '-d', '8', '-Fn'],
    )
  })

  it.each([
    'p123\nf8\nn/workspace/a.png\nn/outside/b.png\n',
    'p123\nf8\nf9\nn/workspace/a.png\n',
    'p123\nf8\nnrelative.png\n',
    'p123\nf8\nn/workspace/a.png (deleted)\n',
    'p123\nf8\nn/workspace/line\\nbreak.png\n',
    'p123\nf9\nn/workspace/a.png\n',
    'p123\nf8\nn/workspace/a.png\nunknown\n',
  ])('macOS 对模糊或不匹配的 lsof 输出 fail-closed', async (stdout) => {
    await expect(resolveWorkspaceImageHandlePath(8, dependencies({
      platform: 'darwin',
      execFile: async () => stdout,
    }))).rejects.toThrow('cannot verify opened image path')
  })

  it('macOS 的 lsof 缺失或失败时不透传 stderr/路径', async () => {
    await expect(resolveWorkspaceImageHandlePath(8, dependencies({
      platform: 'darwin',
      execFile: async () => { throw new Error('/outside/secret.png') },
    }))).rejects.toThrow(/^cannot verify opened image path$/)
  })

  it.each([-1, 1.5, Number.NaN])('拒绝无效 fd：%s', async (fd) => {
    await expect(resolveWorkspaceImageHandlePath(fd, dependencies()))
      .rejects.toThrow('cannot verify opened image path')
  })

  it('不支持的平台明确 fail-closed', async () => {
    await expect(resolveWorkspaceImageHandlePath(4, dependencies({ platform: 'win32' })))
      .rejects.toThrow('cannot verify opened image path')
  })
})

describe.runIf(process.platform === 'darwin')('macOS real lsof handle path', () => {
  let workspace: TempWorkspace

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('从真实已打开 fd 取得最终绝对路径', async () => {
    workspace = await createTempWorkspace()
    const path = join(workspace.root, 'real-handle.png')
    await writeFile(path, 'image')
    const handle = await open(path, 'r')
    try {
      await expect(resolveWorkspaceImageHandlePath(handle.fd)).resolves.toBe(await realpath(path))
    } finally {
      await handle.close()
    }
  })
})
