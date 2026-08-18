// 路径搬运类账的回滚：可恢复删除、复制、移动。
// 整文件改写与 dryRun / 前置关卡在 revertChangeSet.test.ts——两类账的还原方式（按内容写回 vs
// 按整棵路径搬运）、冲突判据（hash vs 存在性/指纹）与失败形态都不一样，分开测才读得清。
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changePayloadPath,
  markChangeApplied,
  prepareCreatedPathChange,
  prepareDeletedPathChange,
  prepareRelocatedPathChange,
} from './prepare'
import { pathFingerprint } from './pathOpsFingerprint'
import { revertChangeSet } from './revertChangeSet'
import {
  changeContext,
  createChangeJournalFixture,
  type ChangeJournalFixture,
} from './changeJournal.testHarness'

let fixture: ChangeJournalFixture

beforeEach(async () => {
  fixture = await createChangeJournalFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function workspaceFile(name: string): string {
  return join(fixture.root, name)
}

async function revert(changeId: string) {
  return revertChangeSet(fixture.journal, changeId, false, fixture.root)
}

describe('revertChangeSet 的可恢复删除', () => {
  async function journalDeletedTree(changeId: string): Promise<void> {
    await mkdir(workspaceFile('tree'))
    await writeFile(join(fixture.root, 'tree', 'inner.txt'), 'inner')
    await prepareDeletedPathChange(fixture.journal, changeContext(changeId), fixture.root, 'tree')
    // delete 域（W10）会先把内容复制进载荷再真删；这里直接搬过去，等价于那两步的结果。
    await rename(workspaceFile('tree'), changePayloadPath(fixture.journal, changeId))
    await markChangeApplied(fixture.journal, changeId)
  }

  it('把整棵目录树从载荷搬回原位', async () => {
    await journalDeletedTree('delete-1')

    const result = await revert('delete-1')

    expect(result.ok).toBe(true)
    expect(result.restoredFiles).toEqual(['tree'])
    await expect(readFile(join(fixture.root, 'tree', 'inner.txt'), 'utf8')).resolves.toBe('inner')
  })

  it('载荷不见了就报 missing_payload，不是「回滚成功但什么都没恢复」', async () => {
    await journalDeletedTree('delete-2')
    await rm(changePayloadPath(fixture.journal, 'delete-2'), { recursive: true })

    const result = await revert('delete-2')

    expect(result.ok).toBe(false)
    expect(result.status).toBe('missing_payload')
    expect(result.error).toBe('recoverable delete payload is missing')
  })

  it('原地被留下一条悬空软链也算「路径被重建」，不覆盖它', async () => {
    await journalDeletedTree('delete-3')
    await symlink(join(fixture.root, 'nowhere'), workspaceFile('tree'))

    const result = await revert('delete-3')

    expect(result.ok).toBe(false)
    expect(result.conflicts).toEqual([
      { path: 'tree', reason: 'deleted path was recreated after the original tool call' },
    ])
  })
})

describe('revertChangeSet 的复制与移动', () => {
  it('撤销一次复制：新建出来的路径被搬进载荷，原地不留东西', async () => {
    await writeFile(workspaceFile('copy.txt'), 'copied')
    await prepareCreatedPathChange(
      fixture.journal,
      changeContext('copy-1'),
      fixture.root,
      'copy.txt',
      await pathFingerprint(workspaceFile('copy.txt')),
    )
    await markChangeApplied(fixture.journal, 'copy-1')

    const result = await revert('copy-1')

    expect(result.ok).toBe(true)
    expect(result.restoredFiles).toEqual(['copy.txt'])
    await expect(readdir(fixture.root)).resolves.toEqual([])
    // 搬进载荷而不是删掉——批量回滚中途失败时要能把它搬回去。
    await expect(
      readFile(join(fixture.journal, 'copy-1.created-0.payload'), 'utf8'),
    ).resolves.toBe('copied')
  })

  it('复制出来的路径被人改过就拒绝', async () => {
    await writeFile(workspaceFile('copy.txt'), 'copied')
    await prepareCreatedPathChange(
      fixture.journal,
      changeContext('copy-2'),
      fixture.root,
      'copy.txt',
      await pathFingerprint(workspaceFile('copy.txt')),
    )
    await markChangeApplied(fixture.journal, 'copy-2')
    await writeFile(workspaceFile('copy.txt'), 'user-edit')

    const result = await revert('copy-2')

    expect(result.conflicts).toEqual([
      { path: 'copy.txt', reason: 'copied path changed after the original tool call' },
    ])
    await expect(readFile(workspaceFile('copy.txt'), 'utf8')).resolves.toBe('user-edit')
  })

  it('撤销一次移动：东西搬回 source，restoredFiles 报的也是 source', async () => {
    await writeFile(workspaceFile('b.txt'), 'moved')
    await prepareRelocatedPathChange(
      fixture.journal,
      changeContext('move-1'),
      fixture.root,
      'a.txt',
      'b.txt',
      await pathFingerprint(workspaceFile('b.txt')),
    )
    await markChangeApplied(fixture.journal, 'move-1')

    const result = await revert('move-1')

    expect(result.ok).toBe(true)
    expect(result.restoredFiles).toEqual(['a.txt'])
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('moved')
    await expect(readdir(fixture.root)).resolves.toEqual(['a.txt'])
  })

  it('source 位置又被人放了东西就拒绝，不覆盖它', async () => {
    await writeFile(workspaceFile('b.txt'), 'moved')
    await prepareRelocatedPathChange(
      fixture.journal,
      changeContext('move-2'),
      fixture.root,
      'a.txt',
      'b.txt',
      await pathFingerprint(workspaceFile('b.txt')),
    )
    await markChangeApplied(fixture.journal, 'move-2')
    await writeFile(workspaceFile('a.txt'), 'user-file')

    const result = await revert('move-2')

    expect(result.conflicts).toEqual([
      { path: 'b.txt', reason: 'moved path changed after the original tool call' },
    ])
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('user-file')
  })
})

