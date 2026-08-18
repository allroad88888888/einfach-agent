import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteFixture, type WriteFixture } from './pipeline.testHarness'
import { MAX_BYTES, REVERSIBLE_MAX_BYTES } from './limits'

let fixture: WriteFixture

beforeEach(async () => {
  fixture = await createWriteFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const readBack = (relative: string): Promise<string> =>
  readFile(join(fixture.root, relative), 'utf8')

describe('模式语义', () => {
  it('create 真把文件写到磁盘，path 是根相对路径', async () => {
    const result = await fixture.write({ path: 'out/hello.txt', content: 'written content' })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.overwritten).toBe(false)
    expect(result.path).toBe('out/hello.txt')
    expect(result.bytes_written).toBe('written content'.length)
    expect(await readBack('out/hello.txt')).toBe('written content')
  })

  it('模式缺省是 create，不是 overwrite', async () => {
    await fixture.write({ path: 'a.txt', content: 'first' })
    const second = await fixture.write({ path: 'a.txt', content: 'second' })
    expect(second.ok).toBe(false)
    expect(second.error).toBe(
      'file already exists; use mode "overwrite" only when replacing it is intentional',
    )
    expect(await readBack('a.txt')).toBe('first')
  })

  it('upsert 不在就建、在就覆盖', async () => {
    const created = await fixture.write({ path: 'notes/entry.txt', content: 'first', mode: 'upsert' })
    expect(created.ok).toBe(true)
    expect(created.created).toBe(true)
    expect(created.overwritten).toBe(false)

    const replaced = await fixture.write({ path: 'notes/entry.txt', content: 'second', mode: 'upsert' })
    expect(replaced.created).toBe(false)
    expect(replaced.overwritten).toBe(true)
    expect(await readBack('notes/entry.txt')).toBe('second')
  })

  it('overwrite 一个不存在的文件被拒，错误指向 upsert', async () => {
    const result = await fixture.write({ path: 'absent.txt', content: 'x', mode: 'overwrite' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('upsert')
  })

  it('append 接在旧内容后面；不记账不验守卫时不给摘要（根本没读过旧内容）', async () => {
    await writeFile(join(fixture.root, 'log.jsonl'), 'one\n')
    const result = await fixture.write({ path: 'log.jsonl', content: 'two\n', mode: 'append' })
    expect(result.ok).toBe(true)
    expect(result.appended).toBe(true)
    expect(result.created).toBe(false)
    expect(result.change_summary).toBeNull()
    expect(await readBack('log.jsonl')).toBe('one\ntwo\n')
  })

  it('拼错的模式给出取值集合而不是一句反序列化失败', async () => {
    const result = await fixture.write({ path: 'a.txt', content: 'x', mode: 'replace' })
    expect(result.error).toBe(
      'invalid mode `replace`; expected `create`, `overwrite`, `upsert`, or `append`',
    )
  })
})

describe('父目录', () => {
  it('createDirs 默认为 true', async () => {
    const result = await fixture.write({ path: 'deep/nested/file.txt', content: 'x' })
    expect(result.ok).toBe(true)
    expect(await readBack('deep/nested/file.txt')).toBe('x')
  })

  it('createDirs=false 时缺父目录被拒，错误自带出路', async () => {
    const result = await fixture.write({ path: 'deep/file.txt', content: 'x', createDirs: false })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('parent directory does not exist; set createDirs=true to create it')
  })
})

describe('限额', () => {
  it('不传 maxBytes 等于取硬上限，600KB 不该被拒', async () => {
    const content = 'y'.repeat(600 * 1024)
    const result = await fixture.write({ path: 'medium.txt', content })
    expect(result.ok).toBe(true)
    expect(result.bytes_written).toBe(content.length)
  })

  it('超限时磁盘上什么都不留，且 path 是**原始入参**（限额排在路径解析之前）', async () => {
    const result = await fixture.write({ path: './out.txt', content: 'abcdef', maxBytes: 3 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('content is too large: 6 bytes exceeds limit 3')
    // 解析成功的话展示路径会是 `out.txt`；这里仍是调用方传进来的那个串。
    expect(result.path).toBe('./out.txt')
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('maxBytes 只能收紧不能放宽', async () => {
    const result = await fixture.write({ path: 'a.txt', content: 'x', maxBytes: MAX_BYTES * 4 })
    expect(result.ok).toBe(true)
  })
})

describe('可逆性', () => {
  it('超出可逆预算的文本照写，只是标明撤不回来', async () => {
    const big = 'x'.repeat(REVERSIBLE_MAX_BYTES + 1024)
    const result = await fixture.write({ path: 'big.txt', content: big })
    expect(result.ok).toBe(true)
    expect(result.bytes_written).toBe(big.length)
    expect(result.reversible).toBe(false)
    expect(result.reversible_reason).toContain('reversible')
  })

  it('覆盖一个二进制文件照样成功，理由来自旧内容', async () => {
    await writeFile(join(fixture.root, 'bin.dat'), Buffer.from([0x00, 0x01]))
    const result = await fixture.write({ path: 'bin.dat', content: 'text', mode: 'overwrite' })
    expect(result.ok).toBe(true)
    expect(result.reversible).toBe(false)
    expect(result.reversible_reason).toBe('binary files are not reversible')
    expect(result.change_summary).toBeNull()
  })

  it('可逆时 reversible_reason 这个键根本不存在', async () => {
    const result = await fixture.write({ path: 'a.txt', content: 'x' })
    expect(result.reversible).toBe(true)
    expect('reversible_reason' in result).toBe(false)
  })
})

describe('dry run', () => {
  it('报出会改什么但不碰磁盘', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'keep\nold\n')
    const result = await fixture.write({
      path: 'code.txt',
      content: 'keep\nnew\n',
      mode: 'overwrite',
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.would_change).toBe(true)
    expect(result.bytes_written).toBe(0)
    expect(result.change_set).toBeNull()
    expect(result.change_summary?.linesAdded).toBe(1)
    expect(result.change_summary?.linesRemoved).toBe(1)
    expect(await readBack('code.txt')).toBe('keep\nold\n')
  })

  it('内容没变时 would_change 为 false', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'same\n')
    const result = await fixture.write({
      path: 'code.txt',
      content: 'same\n',
      mode: 'overwrite',
      dryRun: true,
    })
    expect(result.would_change).toBe(false)
  })

  it('校验照跑：会被拒的写入在 dry run 下同样被拒', async () => {
    const result = await fixture.write({
      path: 'absent.txt',
      content: 'x',
      mode: 'overwrite',
      dryRun: true,
    })
    expect(result.ok).toBe(false)
  })
})

describe('落盘方式', () => {
  it('覆盖不留临时文件', async () => {
    await writeFile(join(fixture.root, 'data.txt'), 'old\n')
    await fixture.write({ path: 'data.txt', content: 'new\n', mode: 'overwrite' })
    const leftovers = (await readdir(fixture.root)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('覆盖保留原文件的可执行位', async () => {
    const target = join(fixture.root, 'run.sh')
    await writeFile(target, '#!/bin/sh\necho old\n', { mode: 0o755 })
    const result = await fixture.write({
      path: 'run.sh',
      content: '#!/bin/sh\necho new\n',
      mode: 'overwrite',
    })
    expect(result.ok).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o755)
  })

  it.runIf(process.platform !== 'win32')('executable 显式置位与清位', async () => {
    const created = await fixture.write({
      path: 'bin/run.sh',
      content: '#!/bin/sh\n',
      executable: true,
    })
    expect(created.ok).toBe(true)
    expect((await stat(join(fixture.root, 'bin/run.sh'))).mode & 0o100).toBe(0o100)

    const cleared = await fixture.write({
      path: 'bin/run.sh',
      content: '#!/bin/sh\necho hi\n',
      mode: 'overwrite',
      executable: false,
    })
    expect(cleared.ok).toBe(true)
    expect((await stat(join(fixture.root, 'bin/run.sh'))).mode & 0o111).toBe(0)
  })
})

describe('路径禁闭', () => {
  it('根外路径被拒，磁盘不动', async () => {
    const result = await fixture.write({ path: '../escape.txt', content: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('..')
    expect(await readdir(fixture.root)).toEqual([])
  })

  it('空路径被拒', async () => {
    const result = await fixture.write({ path: '   ', content: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('path (non-empty string) is required')
  })
})
