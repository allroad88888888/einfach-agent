import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from './pipeline'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { PatchOperation } from './types'

let workspace: TempWorkspace

const onUnix = it.skipIf(process.platform === 'win32')

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

const path = (name: string) => join(workspace.root, name)
const read = (name: string) => readFile(path(name), 'utf8')

const apply = (operations: PatchOperation[], dryRun = false) =>
  applyPatch({ operations, dryRun, workspaceRoot: workspace.root })

describe('applyPatch · 任一失败整体不写', () => {
  it('前面的操作能暂存也照样不落盘——磁盘在拒绝那一刻一个字都没被改过', async () => {
    await writeFile(path('a.txt'), 'old')

    const result = await apply([
      { type: 'overwrite_file', path: 'a.txt', content: 'new', oldContent: 'old' },
      { type: 'add_file', path: 'fresh.txt', content: 'hi' },
      // 第三条不成立：文件不存在。
      { type: 'replace', path: 'missing.txt', oldText: 'x', newText: 'y' },
    ])

    expect(result.ok).toBe(false)
    expect(result.summary).toBe('rejected 1 operation(s); no files changed')
    expect(result.changedFiles).toEqual([])
    expect(result.changes).toEqual([])
    expect(result.wouldChange).toBe(false)
    expect(result.changeSet).toBeNull()
    // 前两条完全成立，但整批不写：a.txt 还是旧的，fresh.txt 根本没被建出来。
    await expect(read('a.txt')).resolves.toBe('old')
    await expect(read('fresh.txt')).rejects.toThrow()
  })

  it('全部试完再汇总，不遇错即停——模型一次就能看到所有问题', async () => {
    const result = await apply([
      { type: 'replace', path: 'missing.txt', oldText: 'x', newText: 'y' },
      { type: 'add_file', path: 'ok.txt', content: 'hi' },
      { type: 'delete_file', path: 'also-missing.txt' },
    ])

    expect(result.rejected).toEqual([
      { index: 0, operation: 'replace', path: 'missing.txt', reason: 'file does not exist' },
      {
        index: 2,
        operation: 'delete_file',
        path: 'also-missing.txt',
        reason: 'file does not exist',
      },
    ])
    expect(result.summary).toBe('rejected 2 operation(s); no files changed')
  })

  it('落盘中途失败：整条命令失败，已写的部分被还原', async () => {
    await writeFile(path('a.txt'), 'old')
    // `zz` 是个文件，所以 `zz/x.txt` 暂存得过（最近已存在祖先就是它），提交时才炸。
    await writeFile(path('zz'), 'i am a file')

    await expect(
      apply([
        { type: 'overwrite_file', path: 'a.txt', content: 'new', oldContent: 'old' },
        { type: 'add_file', path: 'zz/x.txt', content: 'boom' },
      ]),
    ).rejects.toThrow(/^failed to create parent directory `/)

    await expect(read('a.txt')).resolves.toBe('old')
  })
})

describe('applyPatch · 落盘', () => {
  it('新建 / 改写 / 删除一次做完，changedFiles 按展示路径排序', async () => {
    await writeFile(path('edit.txt'), 'keep\nold\n')
    await writeFile(path('gone.txt'), 'bye\n')

    const result = await apply([
      { type: 'add_file', path: 'fresh.txt', content: 'one\ntwo\n' },
      {
        type: 'overwrite_file',
        path: 'edit.txt',
        content: 'keep\nnew\n',
        oldContent: 'keep\nold\n',
      },
      { type: 'delete_file', path: 'gone.txt' },
    ])

    expect(result.ok).toBe(true)
    expect(result.changedFiles).toEqual(['edit.txt', 'fresh.txt', 'gone.txt'])
    expect(result.summary).toBe('applied patch: 3 file(s) changed')
    expect(result.wouldChange).toBe(true)
    await expect(read('edit.txt')).resolves.toBe('keep\nnew\n')
    await expect(read('fresh.txt')).resolves.toBe('one\ntwo\n')
    await expect(read('gone.txt')).rejects.toThrow()
  })

  it('每个文件回一份与 write_file 同形的改动摘要，删除没有摘要', async () => {
    await writeFile(path('edit.txt'), 'keep\nold\n')
    await writeFile(path('gone.txt'), 'bye\n')

    const result = await apply([
      { type: 'add_file', path: 'fresh.txt', content: 'one\ntwo\n' },
      {
        type: 'overwrite_file',
        path: 'edit.txt',
        content: 'keep\nnew\n',
        oldContent: 'keep\nold\n',
      },
      { type: 'delete_file', path: 'gone.txt' },
    ])

    const change = (name: string) => result.changes.find((entry) => entry.path === name)
    expect(change('fresh.txt')).toMatchObject({ created: true, deleted: false })
    expect(change('fresh.txt')?.changeSummary?.linesAdded).toBe(2)
    expect(change('edit.txt')).toMatchObject({ created: false, deleted: false })
    expect(change('edit.txt')?.changeSummary).toMatchObject({ linesAdded: 1, linesRemoved: 1 })
    expect(change('gone.txt')).toMatchObject({ created: false, deleted: true })
    expect(change('gone.txt')?.changeSummary).toBeUndefined()
  })

  it('覆盖成同样的内容 = 无净变化：不写、不进 changedFiles、不刷 mtime', async () => {
    await writeFile(path('same.txt'), 'unchanged\n')
    const before = await stat(path('same.txt'))

    const result = await apply([
      {
        type: 'overwrite_file',
        path: 'same.txt',
        content: 'unchanged\n',
        oldContent: 'unchanged\n',
      },
    ])

    expect(result.ok).toBe(true)
    expect(result.changedFiles).toEqual([])
    expect(result.wouldChange).toBe(false)
    expect(result.summary).toBe('applied patch: 0 file(s) changed')
    expect((await stat(path('same.txt'))).mtimeMs).toBe(before.mtimeMs)
  })

  it('replace 在磁盘上真的改了内容', async () => {
    await writeFile(path('code.txt'), 'const answer = 41;\n')

    const result = await apply([{ type: 'replace', path: 'code.txt', oldText: '41', newText: '42' }])

    expect(result.changedFiles).toEqual(['code.txt'])
    await expect(read('code.txt')).resolves.toBe('const answer = 42;\n')
  })

  onUnix('add_file 带 executable 时新文件直接可执行', async () => {
    await apply([
      { type: 'add_file', path: 'run.sh', content: '#!/bin/sh\n', executable: true },
    ])

    expect((await stat(path('run.sh'))).mode & 0o100).toBe(0o100)
  })
})

describe('applyPatch · dry run', () => {
  it('报告将要发生什么，但磁盘不动', async () => {
    await writeFile(path('edit.txt'), 'old\n')

    const result = await apply(
      [{ type: 'overwrite_file', path: 'edit.txt', content: 'new\n', oldContent: 'old\n' }],
      true,
    )

    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.wouldChange).toBe(true)
    expect(result.summary).toBe('dry run: 1 file(s) would change')
    expect(result.changes[0]?.changeSummary?.linesAdded).toBe(1)
    await expect(read('edit.txt')).resolves.toBe('old\n')
  })
})
