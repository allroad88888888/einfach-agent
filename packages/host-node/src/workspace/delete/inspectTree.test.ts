import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { inspectDeleteTree } from './inspectTree'
import { MAX_BYTES, tooLargeMessage } from './limits'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('inspectDeleteTree 放行', () => {
  it('单个文件', async () => {
    await writeFile(join(workspace.root, 'note.txt'), 'x')
    await expect(inspectDeleteTree(join(workspace.root, 'note.txt'))).resolves.toBeUndefined()
  })

  it('嵌套目录树', async () => {
    await mkdir(join(workspace.root, 'build/nested'), { recursive: true })
    await writeFile(join(workspace.root, 'build/a.txt'), 'a')
    await writeFile(join(workspace.root, 'build/nested/b.txt'), 'b')
    await expect(inspectDeleteTree(join(workspace.root, 'build'))).resolves.toBeUndefined()
  })

  it('空目录', async () => {
    await mkdir(join(workspace.root, 'empty'))
    await expect(inspectDeleteTree(join(workspace.root, 'empty'))).resolves.toBeUndefined()
  })
})

describe('inspectDeleteTree 拒绝', () => {
  it('树里任何一处出现软链就拒整次删除，报的是那一条的绝对路径', async () => {
    await mkdir(join(workspace.root, 'build/nested'), { recursive: true })
    await writeFile(join(workspace.base, 'outside.txt'), 'outside')
    await symlink(join(workspace.base, 'outside.txt'), join(workspace.root, 'build/nested/link'))

    await expect(inspectDeleteTree(join(workspace.root, 'build'))).rejects.toThrow(
      `symbolic links are not supported by recoverable delete: \`${join(workspace.root, 'build/nested/link')}\``,
    )
  })

  it('顶层就是软链', async () => {
    await writeFile(join(workspace.root, 'real.txt'), 'x')
    await symlink(join(workspace.root, 'real.txt'), join(workspace.root, 'link'))
    await expect(inspectDeleteTree(join(workspace.root, 'link'))).rejects.toThrow(
      'symbolic links are not supported by recoverable delete',
    )
  })

  it('读不到的路径', async () => {
    await expect(inspectDeleteTree(join(workspace.root, 'missing'))).rejects.toThrow(
      `failed to inspect \`${join(workspace.root, 'missing')}\``,
    )
  })

  it('字节超限——用稀疏文件撑出 512 MiB + 1，不占实际磁盘', async () => {
    const path = join(workspace.root, 'huge.bin')
    await writeFile(path, '')
    await truncate(path, MAX_BYTES + 1)
    await expect(inspectDeleteTree(path)).rejects.toThrow(tooLargeMessage())
  })

  it('恰好等于字节上限仍然放行（边界是 `>`）', async () => {
    const path = join(workspace.root, 'exact.bin')
    await writeFile(path, '')
    await truncate(path, MAX_BYTES)
    await expect(inspectDeleteTree(path)).resolves.toBeUndefined()
  })
})
