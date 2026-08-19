// 删除的成功路径：删掉了什么、账记成什么样、能不能一字不差地拿回来
// ---------------------------------------------------------------------------
// 「按设计的拒绝」在 pipelineRefusals.test.ts。分两个文件是因为这两组用例问的不是同一件事：
// 这里问「删成功之后世界是什么样」，那里问「什么时候一个字节都不许动」。

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDeleteFixture,
  deleteContext,
  journalEntries,
  pathExists,
  readEntry,
  type DeleteFixture,
} from './pipeline.testHarness'
import { revertChangeSet } from '../change/revertChangeSet'

let fixture: DeleteFixture

beforeEach(async () => {
  fixture = await createDeleteFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('删除文件', () => {
  it('删掉之后账已 applied、载荷留着、回执是可逆的', async () => {
    await writeFile(join(fixture.root, 'image.bin'), Buffer.from([0, 1, 2, 255]))

    const result = await fixture.remove({
      path: 'image.bin',
      changeContext: deleteContext('delete-file'),
    })

    expect(result).toEqual({
      ok: true,
      path: 'image.bin',
      deleted: true,
      kind: 'file',
      reversible: true,
      error: null,
      change_set: { id: 'delete-file', reversible: true },
    })
    expect(await pathExists(join(fixture.root, 'image.bin'))).toBe(false)

    const entry = await readEntry(fixture, 'delete-file')
    expect(entry.status).toBe('applied')
    // 账里记的是**根相对路径**，内容整份挪进了载荷——目录树塞不进 JSON。
    expect(entry.movedPaths).toEqual([{ path: 'image.bin' }])
    expect(entry.files).toEqual([])
    expect(await journalEntries(fixture)).toEqual(['delete-file.json', 'delete-file.payload'])
  })

  it('回滚把二进制内容逐字节放回来', async () => {
    const bytes = Buffer.from([0, 1, 2, 255])
    await writeFile(join(fixture.root, 'image.bin'), bytes)
    await fixture.remove({ path: 'image.bin', changeContext: deleteContext('delete-file') })

    const reverted = await revertChangeSet(fixture.journal, 'delete-file', false, fixture.root)
    expect(reverted.ok).toBe(true)
    expect(await readFile(join(fixture.root, 'image.bin'))).toEqual(bytes)
  })

  it('回滚保住可执行位——权限跟着载荷走，不是只还内容', async () => {
    const script = join(fixture.root, 'run.sh')
    await writeFile(script, '#!/bin/sh\necho hi\n')
    await chmod(script, 0o755)

    await fixture.remove({ path: 'run.sh', changeContext: deleteContext('delete-script') })
    await revertChangeSet(fixture.journal, 'delete-script', false, fixture.root)

    expect((await stat(script)).mode & 0o777).toBe(0o755)
  })

  it('原地被重建过就拒绝回滚，不覆盖用户的新文件', async () => {
    await writeFile(join(fixture.root, 'note.txt'), 'original')
    await fixture.remove({ path: 'note.txt', changeContext: deleteContext('conflict-delete') })
    await writeFile(join(fixture.root, 'note.txt'), 'new user file')

    const reverted = await revertChangeSet(fixture.journal, 'conflict-delete', false, fixture.root)
    expect(reverted.ok).toBe(false)
    expect(reverted.status).toBe('conflict')
    expect(await readFile(join(fixture.root, 'note.txt'), 'utf8')).toBe('new user file')
  })
})

describe('删除目录', () => {
  it('recursive 时整棵树进载荷，回滚能把嵌套内容还原', async () => {
    await mkdir(join(fixture.root, 'build/nested'), { recursive: true })
    await writeFile(join(fixture.root, 'build/a.txt'), 'a')
    await writeFile(join(fixture.root, 'build/nested/b.txt'), 'b')

    const result = await fixture.remove({
      path: 'build',
      recursive: true,
      changeContext: deleteContext('delete-dir'),
    })

    expect(result.ok).toBe(true)
    expect(result.kind).toBe('directory')
    expect(await pathExists(join(fixture.root, 'build'))).toBe(false)
    // 载荷是**一棵目录树**，不是文件——清理与回滚都得按目录处理。
    expect((await stat(join(fixture.journal, 'delete-dir.payload'))).isDirectory()).toBe(true)

    const reverted = await revertChangeSet(fixture.journal, 'delete-dir', false, fixture.root)
    expect(reverted.ok).toBe(true)
    expect(await readFile(join(fixture.root, 'build/a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(fixture.root, 'build/nested/b.txt'), 'utf8')).toBe('b')
  })

  it('空目录也走同一条路', async () => {
    await mkdir(join(fixture.root, 'empty'))
    const result = await fixture.remove({
      path: 'empty',
      recursive: true,
      changeContext: deleteContext('delete-empty'),
    })
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('directory')

    await revertChangeSet(fixture.journal, 'delete-empty', false, fixture.root)
    expect((await stat(join(fixture.root, 'empty'))).isDirectory()).toBe(true)
  })
})

describe('回执形状', () => {
  it('顶层多词键是 snake_case（`change_set`），字段顺序与 Rust struct 一致', async () => {
    await writeFile(join(fixture.root, 'note.txt'), 'x')
    const result = await fixture.remove({
      path: 'note.txt',
      changeContext: deleteContext('shape'),
    })
    expect(Object.keys(result)).toEqual([
      'ok',
      'path',
      'deleted',
      'kind',
      'reversible',
      'error',
      'change_set',
    ])
  })

  it('失败时三个 Option 字段是显式 null，不是「键不存在」', async () => {
    const result = await fixture.remove({ path: '', changeContext: deleteContext('empty-path') })
    expect(result.error).toBe('path (non-empty string) is required')
    expect('kind' in result && 'change_set' in result).toBe(true)
    expect(result.kind).toBeNull()
    expect(result.change_set).toBeNull()
  })

  it('路径解析成功之前失败的话，`path` 是调用方原样传入的串', async () => {
    const result = await fixture.remove({
      path: '  build/../note.txt  ',
      changeContext: deleteContext('raw-path'),
    })
    expect(result.path).toBe('  build/../note.txt  ')
    expect(result.error).toBe('path must not contain `..` components')
  })
})
