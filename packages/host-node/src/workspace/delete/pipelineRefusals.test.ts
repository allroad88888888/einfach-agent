// 什么时候一个字节都不许动
// ---------------------------------------------------------------------------
// 每条拒绝都配一句「原件还在」的断言——只断言 `ok: false` 是不够的：删除是不可逆动作，
// 「报了错但还是删了」正是这块最坏的失败模式，而它不会自己冒出来。
//
// 成功路径在 pipeline.test.ts。

import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDeleteFixture,
  deleteContext,
  journalEntries,
  pathExists,
  type DeleteFixture,
} from './pipeline.testHarness'

let fixture: DeleteFixture

beforeEach(async () => {
  fixture = await createDeleteFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

describe('删除前的拒绝', () => {
  it('workspace root 自己', async () => {
    const result = await fixture.remove({
      path: '.',
      recursive: true,
      changeContext: deleteContext('root'),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('refusing to delete the workspace root')
    expect(await journalEntries(fixture)).toEqual([])
  })

  it('目录不给 recursive 就拒，且一条盘都不碰', async () => {
    await mkdir(join(fixture.root, 'build'))
    await writeFile(join(fixture.root, 'build/a.txt'), 'a')

    const result = await fixture.remove({
      path: 'build',
      changeContext: deleteContext('no-recursive'),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('directory deletion requires recursive=true')
    expect(await pathExists(join(fixture.root, 'build/a.txt'))).toBe(true)
    expect(await journalEntries(fixture)).toEqual([])
  })

  it('软链——链接本身和它指向的东西都还在', async () => {
    await writeFile(join(fixture.base, 'outside.txt'), 'outside')
    await symlink(join(fixture.base, 'outside.txt'), join(fixture.root, 'link'))

    const result = await fixture.remove({ path: 'link', changeContext: deleteContext('symlink') })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('symbolic links are not supported by recoverable delete')
    expect(await pathExists(join(fixture.root, 'link'))).toBe(true)
    expect(await readFile(join(fixture.base, 'outside.txt'), 'utf8')).toBe('outside')
    expect(await journalEntries(fixture)).toEqual([])
  })

  it('路径中间那一段是软链——不然删的是链接指向的真身', async () => {
    await mkdir(join(fixture.root, 'real'))
    await writeFile(join(fixture.root, 'real/note.txt'), 'keep')
    await symlink(join(fixture.root, 'real'), join(fixture.root, 'linked'))

    const result = await fixture.remove({
      path: 'linked/note.txt',
      changeContext: deleteContext('symlink-through'),
    })

    expect(result.ok).toBe(false)
    expect(await readFile(join(fixture.root, 'real/note.txt'), 'utf8')).toBe('keep')
  })

  it('树里藏着软链——预扫阶段就拒，一个字节都不复制', async () => {
    await mkdir(join(fixture.root, 'build/nested'), { recursive: true })
    await writeFile(join(fixture.root, 'build/a.txt'), 'a')
    await symlink(join(fixture.base, 'outside.txt'), join(fixture.root, 'build/nested/link'))

    const result = await fixture.remove({
      path: 'build',
      recursive: true,
      changeContext: deleteContext('tree-symlink'),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('symbolic links are not supported by recoverable delete')
    expect(await readFile(join(fixture.root, 'build/a.txt'), 'utf8')).toBe('a')
    expect(await journalEntries(fixture)).toEqual([])
  })

  it('Git 元数据：`.git` 与它里面的一切', async () => {
    await mkdir(join(fixture.root, '.git'))
    await writeFile(join(fixture.root, '.git/config'), '[core]')

    const directory = await fixture.remove({
      path: '.git',
      recursive: true,
      changeContext: deleteContext('git-dir'),
    })
    expect(directory.error).toBe('recoverable delete refuses Git metadata')

    const inside = await fixture.remove({
      path: '.git/config',
      changeContext: deleteContext('git-file'),
    })
    expect(inside.error).toBe('recoverable delete refuses Git metadata')

    expect(await pathExists(join(fixture.root, '.git/config'))).toBe(true)
    expect(await journalEntries(fixture)).toEqual([])
  })

  it('`.gitignore` 不是 Git 元数据——判据在分量边界上，不是字符串前缀', async () => {
    await writeFile(join(fixture.root, '.gitignore'), 'node_modules')
    const result = await fixture.remove({
      path: '.gitignore',
      changeContext: deleteContext('gitignore'),
    })
    expect(result.ok).toBe(true)
  })

  it('目录先判 recursive、再判 Git——顺序照搬 Rust', async () => {
    await mkdir(join(fixture.root, '.git'))
    const result = await fixture.remove({ path: '.git', changeContext: deleteContext('git-order') })
    expect(result.error).toBe('directory deletion requires recursive=true')
  })

  it('没有 change_context 就不删——删除侧没有「不记账的直接删」这个档位', async () => {
    await writeFile(join(fixture.root, 'note.txt'), 'keep')

    const result = await fixture.remove({ path: 'note.txt' })

    expect(result).toEqual({
      ok: false,
      path: 'note.txt',
      deleted: false,
      kind: null,
      reversible: false,
      error: 'recoverable delete requires runtime change context',
      change_set: null,
    })
    expect(await readFile(join(fixture.root, 'note.txt'), 'utf8')).toBe('keep')
  })

  it('目标不存在——逐段 lstat 先失败，所以报的是解析失败', async () => {
    const result = await fixture.remove({
      path: 'missing.txt',
      changeContext: deleteContext('missing'),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('failed to resolve target path')
  })

  it('根外路径', async () => {
    await writeFile(join(fixture.base, 'secret.txt'), 'secret')
    const result = await fixture.remove({
      path: join(fixture.base, 'secret.txt'),
      changeContext: deleteContext('outside'),
    })
    expect(result.error).toBe('path must stay within the workspace root')
    expect(await readFile(join(fixture.base, 'secret.txt'), 'utf8')).toBe('secret')
  })
})

describe('登记失败', () => {
  it('change id 已被占用——原文件一个字节都不动，上一次的载荷也没被盖掉', async () => {
    await writeFile(join(fixture.root, 'a.txt'), 'a')
    await writeFile(join(fixture.root, 'b.txt'), 'b')
    await fixture.remove({ path: 'a.txt', changeContext: deleteContext('same-id') })

    const second = await fixture.remove({ path: 'b.txt', changeContext: deleteContext('same-id') })

    expect(second.ok).toBe(false)
    expect(second.error).toBe('workspace change id already exists')
    expect(await readFile(join(fixture.root, 'b.txt'), 'utf8')).toBe('b')
    // 载荷被覆盖的话，第一次的删除会当场变成不可恢复——而且不报错。
    expect(await journalEntries(fixture)).toEqual(['same-id.json', 'same-id.payload'])
  })

  it('change id 不合法（它会被原样拼进日志文件路径）', async () => {
    await writeFile(join(fixture.root, 'a.txt'), 'a')
    const result = await fixture.remove({
      path: 'a.txt',
      changeContext: deleteContext('../escape'),
    })
    expect(result.error).toBe('invalid workspace change id')
    expect(await readFile(join(fixture.root, 'a.txt'), 'utf8')).toBe('a')
  })
})
