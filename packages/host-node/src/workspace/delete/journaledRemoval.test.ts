// 记账与执行之间那几步失败时，账不能留下、原件不能少
// ---------------------------------------------------------------------------
// 直接调 `removeWithJournal`（不经流水线的六道拒绝），因为要测的正是「拒绝都过了之后才失败」
// 那几条路径。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { removeWithJournal } from './journaledRemoval'
import { DeleteRejection } from './result'
import type { WorkspaceChangeSet } from '../change/types'

let workspace: TempWorkspace
let journal: string

beforeEach(async () => {
  workspace = await createTempWorkspace()
  journal = join(workspace.base, 'journal')
})

afterEach(async () => {
  await workspace.cleanup()
})

const context = (changeId: string) => ({
  changeId,
  sessionId: 'session',
  runId: 'run',
  toolCallId: 'call',
})

async function journalFiles(): Promise<string[]> {
  return (await readdir(journal).catch(() => [])).sort()
}

describe('removeWithJournal', () => {
  it('成功后账是 applied，载荷留在日志目录里——它是那份内容唯一的副本', async () => {
    await writeFile(join(workspace.root, 'note.txt'), 'content')

    const summary = await removeWithJournal({
      journalDirectory: journal,
      context: context('ok-file'),
      workspaceRoot: workspace.root,
      displayPath: 'note.txt',
      target: join(workspace.root, 'note.txt'),
      directory: false,
    })

    expect(summary).toEqual({ id: 'ok-file', reversible: true })
    expect(await journalFiles()).toEqual(['ok-file.json', 'ok-file.payload'])
    const entry = JSON.parse(
      await readFile(join(journal, 'ok-file.json'), 'utf8'),
    ) as WorkspaceChangeSet
    expect(entry.status).toBe('applied')
    expect(await readFile(join(journal, 'ok-file.payload'), 'utf8')).toBe('content')
  })

  it('目录删除的载荷是整棵树，条目里只记根相对路径', async () => {
    await mkdir(join(workspace.root, 'build/nested'), { recursive: true })
    await writeFile(join(workspace.root, 'build/nested/b.txt'), 'b')

    await removeWithJournal({
      journalDirectory: journal,
      context: context('ok-dir'),
      workspaceRoot: workspace.root,
      displayPath: 'build',
      target: join(workspace.root, 'build'),
      directory: true,
    })

    expect(await readFile(join(journal, 'ok-dir.payload/nested/b.txt'), 'utf8')).toBe('b')
    const entry = JSON.parse(
      await readFile(join(journal, 'ok-dir.json'), 'utf8'),
    ) as WorkspaceChangeSet
    expect(entry.movedPaths).toEqual([{ path: 'build' }])
  })

  it('备份失败时把刚立起来的账整条撤掉——留一条 prepared 的孤儿账会让回滚指向空载荷', async () => {
    // 目标在登记之后、复制之前消失（这里直接给一个不存在的路径来复现那个窗口）。
    const attempt = removeWithJournal({
      journalDirectory: journal,
      context: context('copy-fails'),
      workspaceRoot: workspace.root,
      displayPath: 'gone.txt',
      target: join(workspace.root, 'gone.txt'),
      directory: false,
    })

    await expect(attempt).rejects.toThrow(DeleteRejection)
    await expect(attempt).rejects.toThrow('failed to inspect')
    expect(await journalFiles()).toEqual([])
  })

  it('失败是 DeleteRejection——流水线据此折成 `ok: false` 的回执而不是 invoke 失败', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'a')
    const attempt = removeWithJournal({
      journalDirectory: journal,
      context: context('bad id'),
      workspaceRoot: workspace.root,
      displayPath: 'a.txt',
      target: join(workspace.root, 'a.txt'),
      directory: false,
    })

    await expect(attempt).rejects.toBeInstanceOf(DeleteRejection)
    await expect(attempt).rejects.toThrow('invalid workspace change id')
    // 账没立起来，原件也没动。
    expect(await journalFiles()).toEqual([])
    expect(await readFile(join(workspace.root, 'a.txt'), 'utf8')).toBe('a')
  })
})
