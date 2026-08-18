import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitChanges } from './commit'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { PatchFileState, StagedFiles } from './types'

let workspace: TempWorkspace

const onUnix = it.skipIf(process.platform === 'win32')

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

const path = (name: string) => join(workspace.root, name)

function state(partial: Partial<PatchFileState>): PatchFileState {
  return { initial: null, current: null, executable: null, ...partial }
}

/** 按给定顺序建暂存表。顺序就是提交顺序——生产里由 `changedPaths()` 按展示路径排出来。 */
function staged(entries: Array<[string, PatchFileState]>): { files: StagedFiles; paths: string[] } {
  const files: StagedFiles = new Map()
  for (const [name, value] of entries) files.set(path(name), value)
  return { files, paths: entries.map(([name]) => path(name)) }
}

const read = (name: string) => readFile(path(name), 'utf8')

describe('commitChanges', () => {
  it('新建、改写、删除三种落盘一次做完', async () => {
    await writeFile(path('edit.txt'), 'old')
    await writeFile(path('gone.txt'), 'bye')
    const { files, paths } = staged([
      ['edit.txt', state({ initial: 'old', current: 'new' })],
      ['fresh.txt', state({ current: 'created' })],
      ['gone.txt', state({ initial: 'bye' })],
    ])

    await commitChanges(workspace.root, paths, files)

    await expect(read('edit.txt')).resolves.toBe('new')
    await expect(read('fresh.txt')).resolves.toBe('created')
    await expect(read('gone.txt')).rejects.toThrow()
  })

  onUnix('执行位在写之后置——先置会被 atomicWrite 的权限回填盖掉', async () => {
    const { files, paths } = staged([['run.sh', state({ current: '#!/bin/sh\n', executable: true })]])

    await commitChanges(workspace.root, paths, files)

    expect((await stat(path('run.sh'))).mode & 0o111).toBe(0o111)
  })

  onUnix('executable 为 null 时不动权限位（原有的执行位靠 atomicWrite 的回填保住）', async () => {
    await writeFile(path('keep.sh'), 'old')
    await chmod(path('keep.sh'), 0o755)
    const { files, paths } = staged([['keep.sh', state({ initial: 'old', current: 'new' })]])

    await commitChanges(workspace.root, paths, files)

    expect((await stat(path('keep.sh'))).mode & 0o777).toBe(0o755)
  })

  it('中途失败 → 已写的按 initial 逆序还原：改过的写回去、新建的删掉', async () => {
    await writeFile(path('a.txt'), 'old')
    // 提交到第三条时炸：`zz` 是个文件，`zz/x.txt` 的父目录建不出来。
    await writeFile(path('zz'), 'i am a file')
    const { files, paths } = staged([
      ['a.txt', state({ initial: 'old', current: 'new' })],
      ['b.txt', state({ current: 'created' })],
      ['zz/x.txt', state({ current: 'boom' })],
    ])

    const error = await commitChanges(workspace.root, paths, files).catch((raised: unknown) =>
      raised instanceof Error ? raised.message : String(raised),
    )

    expect(error).toMatch(/^failed to create parent directory `/)
    // 还原成功时**不该**把还原那句话拼进错误里——那会让人以为工作区还是半改的。
    expect(error).not.toContain('failed to rollback')
    await expect(read('a.txt')).resolves.toBe('old')
    await expect(read('b.txt')).rejects.toThrow()
  })

  it('还原自身失败时，两句话都留下且原始错误在前', async () => {
    // 这一批在流水线里是可达的：delete_file `d` + add_file `d/x/y.txt` + add_file `zz/w.txt`
    // ——暂存时 `d` 还是个文件，`d/x/y.txt` 的最近已存在祖先就是它，判定通过。
    await writeFile(path('d'), 'old')
    await writeFile(path('zz'), 'i am a file')
    const { files, paths } = staged([
      ['d', state({ initial: 'old' })],
      ['d/x/y.txt', state({ current: 'new' })],
      ['zz/w.txt', state({ current: 'boom' })],
    ])

    // 提交：删掉文件 d ✓ → 建 d/x/y.txt（mkdir 把 d 变成目录）✓ → zz/w.txt ✗
    // 还原：删掉 d/x/y.txt ✓ → 把 d 写回去 ✗（那个位置现在是一个目录）
    const error = await commitChanges(workspace.root, paths, files).catch((raised: unknown) =>
      raised instanceof Error ? raised.message : String(raised),
    )

    expect(error).toMatch(/^failed to create parent directory `/)
    expect(error).toContain('failed to rollback partially applied patch:')
    expect(error).toContain(`failed to write \`${path('d')}\``)
    // 能救回来的还是救了：新建的那个文件已经删掉。
    await expect(read('d/x/y.txt')).rejects.toThrow()
  })

  it('暂存表里查不到该路径时直接失败，不去猜要还原成什么', async () => {
    const files: StagedFiles = new Map()
    await expect(commitChanges(workspace.root, [path('ghost.txt')], files)).rejects.toThrow(
      `missing staged state for \`${path('ghost.txt')}\``,
    )
  })
})
