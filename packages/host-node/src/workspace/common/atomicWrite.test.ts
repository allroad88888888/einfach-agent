import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite } from './atomicWrite'
import { createTempWorkspace, type TempWorkspace } from './tempWorkspace.testHarness'

const onPosix = process.platform !== 'win32'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

/** 权限位（去掉 file type 位）。 */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777
}

describe('atomicWrite', () => {
  it('整体替换已有文件的内容', async () => {
    const target = join(workspace.root, 'a.txt')
    await writeFile(target, 'old content that is longer')

    await atomicWrite(target, 'new')

    await expect(readFile(target, 'utf8')).resolves.toBe('new')
  })

  it('新建文件，并且不在目录里留下临时文件', async () => {
    const target = join(workspace.root, 'created.txt')
    await atomicWrite(target, new TextEncoder().encode('bytes'))

    await expect(readFile(target, 'utf8')).resolves.toBe('bytes')
    // 临时文件是隐藏的（前导点），readdir 照样看得见——所以「只剩目标文件」这条断言是有效的。
    await expect(readdir(workspace.root)).resolves.toEqual(['created.txt'])
  })

  it.skipIf(!onPosix)('保留原文件的可执行位', async () => {
    // 这条是本模块最容易静默失效的一处：rename 保留的是**临时文件**的权限（受 umask 影响，
    // 通常 0644），不回填的话一次覆盖就把脚本的可执行位抹掉了，而症状要等到几周后
    // 「那个脚本怎么跑不了了」才出现。
    const target = join(workspace.root, 'run.sh')
    await writeFile(target, '#!/bin/sh\necho old\n')
    await chmod(target, 0o755)

    await atomicWrite(target, '#!/bin/sh\necho new\n')

    await expect(readFile(target, 'utf8')).resolves.toBe('#!/bin/sh\necho new\n')
    expect(await modeOf(target)).toBe(0o755)
    // 单独把可执行位再断一次：整值断言若哪天被改成「大致相等」，这条还在。
    expect((await modeOf(target)) & 0o111).not.toBe(0)
  })

  it.skipIf(!onPosix)('保留原文件的收紧权限（不因为覆盖而放宽）', async () => {
    const target = join(workspace.root, 'secret.key')
    await writeFile(target, 'old')
    await chmod(target, 0o600)

    await atomicWrite(target, 'new')

    expect(await modeOf(target)).toBe(0o600)
  })

  it.skipIf(!onPosix)('新建文件不继承任何人的权限，按 umask 走', async () => {
    const target = join(workspace.root, 'fresh.txt')
    await atomicWrite(target, 'x')
    // 只断「不是可执行文件」：具体值由 umask 决定，不该在测试里钉死。
    expect((await modeOf(target)) & 0o111).toBe(0)
  })

  it('替换失败时清掉临时文件，不在工作区里留垃圾', async () => {
    // 目标是个目录 → rename 必然失败。留一堆 `.x.12345-....tmp` 既污染 git status 也污染下一次
    // list，所以失败路径必须自己收拾干净。
    const target = join(workspace.root, 'a-directory')
    await mkdir(target)

    await expect(atomicWrite(target, 'nope')).rejects.toThrow()
    await expect(readdir(workspace.root)).resolves.toEqual(['a-directory'])
  })

  it('同目录并发写多个文件互不干扰，且无残留', async () => {
    // 临时文件名带 pid + 纳秒，正是为了让并发写不撞名。
    const names = Array.from({ length: 12 }, (_, index) => `file-${index}.txt`)
    await Promise.all(names.map((name) => atomicWrite(join(workspace.root, name), name)))

    // readdir 的顺序由文件系统决定，两边都排一遍再比。
    expect((await readdir(workspace.root)).sort()).toEqual([...names].sort())
    for (const name of names) {
      await expect(readFile(join(workspace.root, name), 'utf8')).resolves.toBe(name)
    }
  })

  it('没有父目录的目标明确失败', async () => {
    await expect(atomicWrite('/', 'nope')).rejects.toThrow(/no parent directory/)
  })
})
