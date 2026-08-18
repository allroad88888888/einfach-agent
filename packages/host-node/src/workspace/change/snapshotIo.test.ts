import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileSnapshotFromContent } from './fileSnapshot'
import { readSnapshot, writeSnapshot } from './snapshotIo'
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

describe('readSnapshot', () => {
  it('文件不存在给的是「不存在」快照，不是错误', async () => {
    expect(await readSnapshot(at('missing.txt'))).toEqual(fileSnapshotFromContent(null))
  })

  it('文本文件读成内容快照', async () => {
    await writeFile(at('a.txt'), 'hello')
    expect(await readSnapshot(at('a.txt'))).toEqual(fileSnapshotFromContent('hello'))
  })

  it('BOM 原样保留——被吃掉的话 hash 与桌面版算的对不上，回滚会被误判成冲突', async () => {
    await writeFile(at('bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]))
    const snapshot = await readSnapshot(at('bom.txt'))
    expect(snapshot.content).toBe('﻿a')
    expect(snapshot).toEqual(fileSnapshotFromContent('﻿a'))
  })

  it('含 NUL 的二进制文件明确拒绝', async () => {
    await writeFile(at('bin'), Buffer.from([0x61, 0x00, 0x62]))
    await expect(readSnapshot(at('bin'))).rejects.toThrow('binary file is not reversible')
  })

  it('非 UTF-8 明确拒绝，而不是 lossy 解码出一串替换字符再去比 hash', async () => {
    await writeFile(at('latin'), Buffer.from([0xff, 0xfe, 0x41]))
    await expect(readSnapshot(at('latin'))).rejects.toThrow('non-UTF-8 file is not reversible')
  })
})

describe('writeSnapshot', () => {
  it('有内容就写回，缺失的父目录建出来', async () => {
    await writeSnapshot(workspace.root, at('nested', 'a.txt'), fileSnapshotFromContent('restored'))
    await expect(readFile(at('nested', 'a.txt'), 'utf8')).resolves.toBe('restored')
  })

  it('content 为 null 的语义是删除，不是写空文件', async () => {
    await writeFile(at('a.txt'), 'x')
    await writeSnapshot(workspace.root, at('a.txt'), fileSnapshotFromContent(null))
    await expect(readdir(workspace.root)).resolves.toEqual([])
  })

  it('content 为空串写的是空文件——与 null 差一个字符，后果是清空与删除之别', async () => {
    await writeFile(at('a.txt'), 'x')
    await writeSnapshot(workspace.root, at('a.txt'), fileSnapshotFromContent(''))
    await expect(readFile(at('a.txt'), 'utf8')).resolves.toBe('')
  })

  it('删除一个本来就不存在的文件是静默成功（回滚「新建」时反复重试也不该报错）', async () => {
    await expect(
      writeSnapshot(workspace.root, at('missing.txt'), fileSnapshotFromContent(null)),
    ).resolves.toBeUndefined()
  })

  it('词法上就在 root 外的路径直接拒', async () => {
    await expect(
      writeSnapshot(workspace.root, join(workspace.base, 'outside.txt'), fileSnapshotFromContent('x')),
    ).rejects.toThrow('recorded path escaped workspace root')
  })

  it('经由软链绕到 root 外的路径也拒——词法比对看不出这一种', async () => {
    await mkdir(join(workspace.base, 'outside'))
    await symlink(join(workspace.base, 'outside'), at('link'))

    await expect(
      writeSnapshot(workspace.root, at('link', 'a.txt'), fileSnapshotFromContent('x')),
    ).rejects.toThrow('recorded path escaped workspace root')
    await expect(readdir(join(workspace.base, 'outside'))).resolves.toEqual([])
  })
})
