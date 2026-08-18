import { Buffer } from 'node:buffer'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beforeExisted, beforeText, readBeforeContent } from './before'
import { MAX_BYTES } from './limits'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('readBeforeContent', () => {
  it('文件不存在 → missing', async () => {
    const before = await readBeforeContent(join(workspace.root, 'absent.txt'))
    expect(before.kind).toBe('missing')
    expect(beforeExisted(before)).toBe(false)
    expect(beforeText(before)).toBeNull()
  })

  it('普通文本 → text，内容逐字保留', async () => {
    const path = join(workspace.root, 'a.txt')
    await writeFile(path, 'one\ntwo\n')
    const before = await readBeforeContent(path)
    expect(before).toEqual({ kind: 'text', text: 'one\ntwo\n' })
    expect(beforeExisted(before)).toBe(true)
  })

  it('BOM 原样保留——TextDecoder 默认会把它吃掉，那样写进日志的文本比磁盘上少三个字节', async () => {
    const path = join(workspace.root, 'bom.txt')
    await writeFile(path, '﻿hello\n')
    expect(beforeText(await readBeforeContent(path))).toBe('﻿hello\n')
  })

  it('含 NUL 的文件 → unsupported（二进制）', async () => {
    const path = join(workspace.root, 'bin.dat')
    await writeFile(path, Buffer.from([0x89, 0x50, 0x00, 0xff]))
    const before = await readBeforeContent(path)
    expect(before).toEqual({ kind: 'unsupported', reason: 'binary files are not reversible' })
    // 「读不出来」也算存在——它只是不可逆，不是不在。
    expect(beforeExisted(before)).toBe(true)
    expect(beforeText(before)).toBeNull()
  })

  it('非 UTF-8 但不含 NUL 的文件 → unsupported（非 UTF-8）', async () => {
    const path = join(workspace.root, 'latin1.txt')
    await writeFile(path, Buffer.from([0x68, 0x69, 0xff, 0xfe]))
    expect(await readBeforeContent(path)).toEqual({
      kind: 'unsupported',
      reason: 'non-UTF-8 files are not reversible',
    })
  })

  it('目录 → unsupported（只支持普通文件）', async () => {
    const path = join(workspace.root, 'dir')
    await mkdir(path)
    expect(await readBeforeContent(path)).toEqual({
      kind: 'unsupported',
      reason: 'rollback only supports regular files',
    })
  })

  it('超过硬上限的文件不读进内存，直接给出理由（文案照搬 Rust，"reversible" 与常量对不上）', async () => {
    // 稀疏文件：只写最后一个字节，磁盘占用几乎为零，但 stat 报的大小越过 8 MiB 硬顶。
    // 判据看的就是 stat，所以这条不必真造一个 8 MB 的文件。
    const path = join(workspace.root, 'huge.bin')
    const handle = await open(path, 'w')
    await handle.write(Buffer.from([0x61]), 0, 1, MAX_BYTES)
    await handle.close()
    expect(await readBeforeContent(path)).toEqual({
      kind: 'unsupported',
      reason: `existing file exceeds reversible ${MAX_BYTES} byte limit`,
    })
  })
})
