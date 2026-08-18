import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveRecordedPath } from './recordedPath'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

function resolve(relative: string): Promise<string> {
  return resolveRecordedPath(workspace.root, relative)
}

describe('resolveRecordedPath', () => {
  it('已存在的文件解析成 canonical 绝对路径', async () => {
    await mkdir(join(workspace.root, 'src'))
    await writeFile(join(workspace.root, 'src', 'a.ts'), 'x')

    await expect(resolve('src/a.ts')).resolves.toBe(join(workspace.root, 'src', 'a.ts'))
  })

  it('还不存在的路径照样给得出来——回滚「删除」正需要在那个位置建文件', async () => {
    await expect(resolve('src/new.ts')).resolves.toBe(join(workspace.root, 'src', 'new.ts'))
  })

  it('绝对路径直接拒（条目声称自己是相对路径这件事不能当真）', async () => {
    await expect(resolve(join(workspace.base, 'outside.txt'))).rejects.toThrow(
      'invalid path in workspace change journal',
    )
  })

  it('含 `..` 的路径直接拒——目标可能还不存在，realpath 无从下手', async () => {
    await expect(resolve('src/../../outside.txt')).rejects.toThrow(
      'invalid path in workspace change journal',
    )
  })

  it('软链指向 root 外时拒绝，哪怕词法上完全不越界', async () => {
    await mkdir(join(workspace.base, 'outside'))
    await writeFile(join(workspace.base, 'outside', 'secret.txt'), 'secret')
    await symlink(join(workspace.base, 'outside'), join(workspace.root, 'link'))

    await expect(resolve('link/secret.txt')).rejects.toThrow('recorded path escaped workspace root')
  })

  it('目标不存在但祖先落在 root 外时同样拒绝', async () => {
    await mkdir(join(workspace.base, 'outside'))
    await symlink(join(workspace.base, 'outside'), join(workspace.root, 'link'))

    await expect(resolve('link/new.txt')).rejects.toThrow('recorded path escaped workspace root')
  })
})
