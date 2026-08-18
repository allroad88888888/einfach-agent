import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyExecutableBit,
  deleteFileIfPresent,
  readOptionalTextFile,
  writeTextFile,
} from './fs'
import { MAX_FILE_BYTES } from './limits'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

/** unix 专属断言（执行位、权限回填）在 Windows 上没有对应物，整条跳过而不是断言 no-op。 */
const onUnix = it.skipIf(process.platform === 'win32')

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

const path = (name: string) => join(workspace.root, name)

async function mode(name: string): Promise<number> {
  return (await stat(path(name))).mode & 0o777
}

describe('readOptionalTextFile', () => {
  it('文件不存在给 null，而不是抛错', async () => {
    await expect(readOptionalTextFile(path('missing.txt'))).resolves.toBeNull()
  })

  it('断链算作不存在（`Path::exists()` 跟随链接，解不开就是 false）', async () => {
    await symlink(path('nowhere.txt'), path('dangling'))
    await expect(readOptionalTextFile(path('dangling'))).resolves.toBeNull()
  })

  it('读得回原文（含多字节字符）', async () => {
    await writeFile(path('a.txt'), '第一行\n第二行\n')
    await expect(readOptionalTextFile(path('a.txt'))).resolves.toBe('第一行\n第二行\n')
  })

  it('目录不是普通文件——文案带绝对路径，照搬 Rust', async () => {
    await mkdir(path('dir'))
    await expect(readOptionalTextFile(path('dir'))).rejects.toThrow(
      `\`${path('dir')}\` is not a regular file`,
    )
  })

  it('超过 1 MiB 直接拒，文案不带 label（与 limits.ts 那套区分开）', async () => {
    await writeFile(path('big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))
    await expect(readOptionalTextFile(path('big.txt'))).rejects.toThrow(
      `file exceeds ${MAX_FILE_BYTES} byte limit`,
    )
  })

  it('含 NUL 字节的文件按二进制拒', async () => {
    await writeFile(path('bin'), Buffer.from([0x61, 0x00, 0x62]))
    await expect(readOptionalTextFile(path('bin'))).rejects.toThrow('binary files are not supported')
  })

  it('非法 UTF-8 同样按二进制拒——不能悄悄替换成 `�`', async () => {
    // Rust 的 String::from_utf8 是报错不是 lossy；替换掉的话补丁会把坏字节写成替换字符再存回去。
    await writeFile(path('bad'), Buffer.from([0xff, 0xfe, 0x41]))
    await expect(readOptionalTextFile(path('bad'))).rejects.toThrow('binary files are not supported')
  })
})

describe('writeTextFile', () => {
  it('父目录不存在时自己建出来', async () => {
    await writeTextFile(workspace.root, path('deep/nested/a.txt'), 'hi')
    await expect(readFile(path('deep/nested/a.txt'), 'utf8')).resolves.toBe('hi')
  })

  onUnix('覆盖已存在的文件时保留它的权限位（atomicWrite 的回填）', async () => {
    await writeFile(path('run.sh'), 'old')
    await chmod(path('run.sh'), 0o755)

    await writeTextFile(workspace.root, path('run.sh'), 'new')

    await expect(readFile(path('run.sh'), 'utf8')).resolves.toBe('new')
    expect(await mode('run.sh')).toBe(0o755)
  })

  it('父目录经软链指到根外时拒写', async () => {
    await mkdir(join(workspace.base, 'outside'))
    await symlink(join(workspace.base, 'outside'), path('escape'))

    await expect(writeTextFile(workspace.root, path('escape/a.txt'), 'x')).rejects.toThrow(
      'parent directory is outside the workspace root',
    )
    // 拒了就是一个字都没写出去。
    await expect(readFile(join(workspace.base, 'outside/a.txt'), 'utf8')).rejects.toThrow()
  })

  it('父路径其实是个文件时，报的是建目录失败', async () => {
    await writeFile(path('blocker'), 'i am a file')
    await expect(writeTextFile(workspace.root, path('blocker/a.txt'), 'x')).rejects.toThrow(
      /^failed to create parent directory `/,
    )
  })
})

describe('applyExecutableBit', () => {
  onUnix('置位只发给「读得到」的角色：0644 → 0755，0600 → 0700', async () => {
    await writeFile(path('a.sh'), '#!/bin/sh\n')
    await chmod(path('a.sh'), 0o644)
    await applyExecutableBit(path('a.sh'), true)
    expect(await mode('a.sh')).toBe(0o755)

    await writeFile(path('b.sh'), '#!/bin/sh\n')
    await chmod(path('b.sh'), 0o600)
    await applyExecutableBit(path('b.sh'), true)
    // 直接 `| 0o111` 会给 group/other 发一个它们连读都没有的执行位。
    expect(await mode('b.sh')).toBe(0o700)
  })

  onUnix('清位是无条件的 `& ~0o111`', async () => {
    await writeFile(path('c.sh'), '#!/bin/sh\n')
    await chmod(path('c.sh'), 0o755)
    await applyExecutableBit(path('c.sh'), false)
    expect(await mode('c.sh')).toBe(0o644)
  })

  it('文件不存在时报「取不到文件模式」', async () => {
    if (process.platform === 'win32') return
    await expect(applyExecutableBit(path('missing'), true)).rejects.toThrow(
      /^failed to inspect file mode: /,
    )
  })
})

describe('deleteFileIfPresent', () => {
  it('本来就不在也算成功（回滚会重复走到这条）', async () => {
    await expect(deleteFileIfPresent(path('missing.txt'))).resolves.toBeUndefined()
  })

  it('删掉已存在的文件', async () => {
    await writeFile(path('gone.txt'), 'bye')
    await deleteFileIfPresent(path('gone.txt'))
    await expect(readFile(path('gone.txt'), 'utf8')).rejects.toThrow()
  })
})
