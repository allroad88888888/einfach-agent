// 补偿路径的直接测试。它在生产里只被 revertChangeSets 调用、且**错误一律被吞掉**——
// 写错了不会有任何症状浮出来，只会在批量回滚失败时静默留下一个退了一半的工作区。
// 所以它必须有自己的用例，不能只靠「批量失败」那条路顺带覆盖。
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathFingerprint } from './pathOpsFingerprint'
import { markChangeApplied, prepareCreatedPathChange, prepareRelocatedPathChange } from './prepare'
import { reapplyChangeSet } from './reapplyChangeSet'
import { revertChangeSet } from './revertChangeSet'
import {
  applyChangeSet,
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

async function revertThenReapply(changeId: string): Promise<void> {
  expect((await revertChangeSet(fixture.journal, changeId, false, fixture.root)).ok).toBe(true)
  await reapplyChangeSet(fixture.journal, changeId, fixture.root)
}

async function entryStatus(changeId: string): Promise<string> {
  const entry = JSON.parse(await readFile(join(fixture.journal, `${changeId}.json`), 'utf8'))
  return entry.status
}

describe('reapplyChangeSet', () => {
  it('整文件改写：写回 after，状态推回 applied', async () => {
    await writeFile(workspaceFile('a.txt'), 'after')
    await applyChangeSet(fixture, 'files-1', [
      { path: 'a.txt', before: 'before', after: 'after' },
      { path: 'created.txt', before: null, after: 'created' },
    ])
    await writeFile(workspaceFile('created.txt'), 'created')

    await revertThenReapply('files-1')

    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('after')
    await expect(readFile(workspaceFile('created.txt'), 'utf8')).resolves.toBe('created')
    expect(await entryStatus('files-1')).toBe('applied')
  })

  it('复制：把回滚时搬进 created-N 载荷的东西原样搬回来', async () => {
    await writeFile(workspaceFile('copy.txt'), 'copied')
    await prepareCreatedPathChange(
      fixture.journal,
      changeContext('copy-1'),
      fixture.root,
      'copy.txt',
      await pathFingerprint(workspaceFile('copy.txt')),
    )
    await markChangeApplied(fixture.journal, 'copy-1')

    await revertThenReapply('copy-1')

    await expect(readFile(workspaceFile('copy.txt'), 'utf8')).resolves.toBe('copied')
    // 载荷用完就该空了——留着的话下一轮补偿会拿到一份陈旧副本。
    await expect(readdir(fixture.journal)).resolves.toEqual(['copy-1.json'])
  })

  it('移动：把搬回 source 的东西再搬到 destination', async () => {
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

    await revertThenReapply('move-1')

    await expect(readFile(workspaceFile('b.txt'), 'utf8')).resolves.toBe('moved')
    await expect(readdir(fixture.root)).resolves.toEqual(['b.txt'])
  })

  it('补回去之前发现现场又被改过就报错，不硬写盖掉别人刚写的东西', async () => {
    await writeFile(workspaceFile('a.txt'), 'after')
    await applyChangeSet(fixture, 'drift-1', [{ path: 'a.txt', before: 'before', after: 'after' }])
    expect((await revertChangeSet(fixture.journal, 'drift-1', false, fixture.root)).ok).toBe(true)
    await writeFile(workspaceFile('a.txt'), 'someone-else')

    await expect(reapplyChangeSet(fixture.journal, 'drift-1', fixture.root)).rejects.toThrow(
      'cannot compensate changed file a.txt',
    )
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('someone-else')
  })
})
