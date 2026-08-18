import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyPath } from './pathOpsCopy'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

function at(...segments: string[]): string {
  return join(workspace.root, ...segments)
}

describe('copyPath', () => {
  it('复制单个文件并保住权限位（可执行位丢了的话恢复出来的脚本跑不起来）', async () => {
    await writeFile(at('run.sh'), '#!/bin/sh\n')
    await chmod(at('run.sh'), 0o751)

    await copyPath(at('run.sh'), at('nested', 'copy.sh'))

    await expect(readFile(at('nested', 'copy.sh'), 'utf8')).resolves.toBe('#!/bin/sh\n')
    expect((await lstat(at('nested', 'copy.sh'))).mode & 0o777).toBe(0o751)
  })

  it('整棵目录树连同子目录一起复制', async () => {
    await mkdir(at('tree', 'inner'), { recursive: true })
    await writeFile(at('tree', 'top.txt'), 'top')
    await writeFile(at('tree', 'inner', 'deep.txt'), 'deep')

    await copyPath(at('tree'), at('copy'))

    await expect(readFile(at('copy', 'top.txt'), 'utf8')).resolves.toBe('top')
    await expect(readFile(at('copy', 'inner', 'deep.txt'), 'utf8')).resolves.toBe('deep')
  })

  it('目标已存在就拒——载荷撞车会盖掉上一次删除的唯一副本', async () => {
    await writeFile(at('a.txt'), 'a')
    await writeFile(at('b.txt'), 'b')

    await expect(copyPath(at('a.txt'), at('b.txt'))).rejects.toThrow(
      `destination already exists: \`${at('b.txt')}\``,
    )
    await expect(readFile(at('b.txt'), 'utf8')).resolves.toBe('b')
  })

  it('源是符号链接就拒，不去猜该拷贝链接本身还是它指向的东西', async () => {
    await writeFile(at('target.txt'), 'target')
    await symlink(at('target.txt'), at('link.txt'))

    await expect(copyPath(at('link.txt'), at('copy.txt'))).rejects.toThrow(
      'symbolic links are not supported by recoverable delete',
    )
  })

  it('树里含符号链接时整棵拒绝，并把已经复制出来的半成品删掉', async () => {
    await mkdir(at('tree'))
    await writeFile(at('tree', 'ok.txt'), 'ok')
    await symlink(at('tree', 'ok.txt'), at('tree', 'link.txt'))

    await expect(copyPath(at('tree'), at('copy'))).rejects.toThrow(
      'symbolic links are not supported by recoverable delete',
    )
    // 半成品留下的话，`prepareDeletedPathChange` 的载荷占用检查会以为这里已经有账了。
    await expect(readdir(workspace.root)).resolves.toEqual(['tree'])
  })

  it('源不存在时报的是「查不到」，不是静默成功', async () => {
    await expect(copyPath(at('missing'), at('copy'))).rejects.toThrow('failed to inspect')
  })
})
