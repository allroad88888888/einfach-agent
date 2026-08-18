import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changePayloadPath, markChangeApplied, prepareDeletedPathChange } from './prepare'
import { revertChangeSet } from './revertChangeSet'
import { revertChangeSets } from './revertChangeSets'
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

async function revertBatch(ids: string[], dryRun = false) {
  return revertChangeSets(fixture.journal, ids, dryRun, fixture.root)
}

async function entryStatus(changeId: string): Promise<string> {
  const entry = JSON.parse(await readFile(join(fixture.journal, `${changeId}.json`), 'utf8'))
  return entry.status
}

describe('revertChangeSets 的整批回滚', () => {
  it('逆着创建顺序退，同一个文件的两次改动一路退回最初版本', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-3')
    await writeFile(workspaceFile('b.txt'), 'b-2')
    await applyChangeSet(fixture, 'batch-1', [
      { path: 'a.txt', before: 'a-1', after: 'a-2' },
      { path: 'b.txt', before: 'b-1', after: 'b-2' },
    ])
    await applyChangeSet(fixture, 'batch-2', [{ path: 'a.txt', before: 'a-2', after: 'a-3' }])

    const result = await revertBatch(['batch-1', 'batch-2'])

    expect(result.ok).toBe(true)
    expect(result.status).toBe('batch_reverted')
    expect(result.revertedChangeSetIds).toEqual(['batch-2', 'batch-1'])
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-1')
    await expect(readFile(workspaceFile('b.txt'), 'utf8')).resolves.toBe('b-1')
  })

  it('顺序由账本的 createdAt 定，把入参顺序打乱结果一模一样', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-3')
    await applyChangeSet(fixture, 'ord-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'ord-2', [{ path: 'a.txt', before: 'a-2', after: 'a-3' }])

    // 调用方按「先退老的」这种错误顺序传——并行子 Agent 拼出来的批次就长这样。
    const result = await revertBatch(['ord-2', 'ord-1'])

    expect(result.ok).toBe(true)
    expect(result.revertedChangeSetIds).toEqual(['ord-2', 'ord-1'])
    // 顺序若跟着入参走，这里会停在 a-2（先退 ord-1 写回 a-1，再退 ord-2 又写回 a-2）。
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-1')
  })

  it('restoredFiles 也是逆序的，一条账内部仍按账上顺序', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await writeFile(workspaceFile('b.txt'), 'b-2')
    await applyChangeSet(fixture, 'list-1', [
      { path: 'a.txt', before: 'a-1', after: 'a-2' },
      { path: 'b.txt', before: 'b-1', after: 'b-2' },
    ])
    await applyChangeSet(fixture, 'list-2', [{ path: 'c.txt', before: null, after: null }])

    const preview = await revertBatch(['list-1', 'list-2'], true)

    expect(preview.restoredFiles).toEqual(['c.txt', 'a.txt', 'b.txt'])
  })

  it('已经回滚过的账被跳过，不算错也不进 revertedChangeSetIds', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await writeFile(workspaceFile('b.txt'), 'b-2')
    await applyChangeSet(fixture, 'skip-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'skip-2', [{ path: 'b.txt', before: 'b-1', after: 'b-2' }])
    await revertChangeSet(fixture.journal, 'skip-2', false, fixture.root)

    const result = await revertBatch(['skip-1', 'skip-2'])

    expect(result.ok).toBe(true)
    expect(result.revertedChangeSetIds).toEqual(['skip-1'])
    expect(result.restoredFiles).toEqual(['a.txt'])
  })
})

describe('revertChangeSets 的预检', () => {
  it('任一条账对不上就整批拒绝，两个文件都不动', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await writeFile(workspaceFile('b.txt'), 'user-edit')
    await applyChangeSet(fixture, 'safe-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'conflict-1', [{ path: 'b.txt', before: 'b-1', after: 'b-2' }])

    const result = await revertBatch(['safe-1', 'conflict-1'])

    expect(result.ok).toBe(false)
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toEqual([
      { path: 'b.txt', reason: 'state does not match change set conflict-1' },
    ])
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-2')
    await expect(readFile(workspaceFile('b.txt'), 'utf8')).resolves.toBe('user-edit')
  })

  it('模拟表让老账按「新账已退」的状态判定，而不是拿磁盘现状硬比', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-3')
    await applyChangeSet(fixture, 'sim-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'sim-2', [{ path: 'a.txt', before: 'a-2', after: 'a-3' }])

    // 单条预演里 sim-1 是冲突（现状是 a-3），整批预演里它成立。
    expect((await revertChangeSet(fixture.journal, 'sim-1', true, fixture.root)).status).toBe(
      'conflict',
    )
    expect((await revertBatch(['sim-1', 'sim-2'], true)).status).toBe('batch_ready')
  })

  it('重复 id 直接拒——同一条账在一批里出现两次是调用方算错了', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await applyChangeSet(fixture, 'dup-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])

    const result = await revertBatch(['dup-1', 'dup-1'])

    expect(result).toEqual({
      ok: false,
      status: 'failed',
      restoredFiles: [],
      conflicts: [],
      error: 'duplicate change set id: dup-1',
      revertedChangeSetIds: [],
    })
  })

  it('同一路径既被删除又被整文件改写时整批拒绝，不去猜谁先谁后', async () => {
    await writeFile(workspaceFile('tree'), 'file-content')
    await prepareDeletedPathChange(fixture.journal, changeContext('mix-1'), fixture.root, 'tree')
    await rename(workspaceFile('tree'), changePayloadPath(fixture.journal, 'mix-1'))
    await markChangeApplied(fixture.journal, 'mix-1')
    await applyChangeSet(fixture, 'mix-2', [{ path: 'tree', before: 'old', after: null }])

    const result = await revertBatch(['mix-1', 'mix-2'])

    expect(result.ok).toBe(false)
    expect(result.status).toBe('conflict')
    expect(result.error).toBe(
      'batch rollback cannot safely combine overlapping path-delete and file changes',
    )
    expect(result.conflicts).toEqual([])
  })

  it('某一条账的载荷丢了，整批报 missing_payload 并点名是哪条', async () => {
    await mkdir(workspaceFile('gone'))
    await prepareDeletedPathChange(fixture.journal, changeContext('pay-1'), fixture.root, 'gone')
    await markChangeApplied(fixture.journal, 'pay-1')
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await applyChangeSet(fixture, 'pay-2', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])

    const result = await revertBatch(['pay-1', 'pay-2'])

    expect(result.ok).toBe(false)
    expect(result.status).toBe('missing_payload')
    expect(result.error).toBe('recoverable delete payload is missing for pay-1')
  })

  it('批次里混进别的 workspace 的账时整批拒绝', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await applyChangeSet(fixture, 'ws-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    const elsewhere = await createChangeJournalFixture()

    try {
      const result = await revertChangeSets(fixture.journal, ['ws-1'], false, elsewhere.root)
      expect(result.status).toBe('workspace_mismatch')
      expect(result.error).toBe('change set ws-1 belongs to a different workspace')
    } finally {
      await elsewhere.cleanup()
    }
  })
})

describe('revertChangeSets 的 dryRun 与部分失败', () => {
  it('dryRun 报的清单与真跑一致，但一条盘都不碰、账的状态不变', async () => {
    await writeFile(workspaceFile('a.txt'), 'a-3')
    await applyChangeSet(fixture, 'pre-1', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'pre-2', [{ path: 'a.txt', before: 'a-2', after: 'a-3' }])

    const preview = await revertBatch(['pre-1', 'pre-2'], true)

    expect(preview).toEqual({
      ok: true,
      status: 'batch_ready',
      restoredFiles: ['a.txt', 'a.txt'],
      conflicts: [],
      error: null,
      revertedChangeSetIds: [],
    })
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-3')
    expect(await entryStatus('pre-1')).toBe('applied')
    expect(await entryStatus('pre-2')).toBe('applied')

    const real = await revertBatch(['pre-1', 'pre-2'])
    expect(real.restoredFiles).toEqual(preview.restoredFiles)
    expect(real.status).toBe('batch_reverted')
    expect(real.revertedChangeSetIds).toEqual(['pre-2', 'pre-1'])
  })

  it('执行到第二条失败时把第一条重新应用回去，整批状态回到没退过的样子', async () => {
    // b.txt 只读：预检读得到，退到它时写回失败。它记在**更老**的那条账上，所以先退 a.txt 那条。
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await writeFile(workspaceFile('b.txt'), 'b-2')
    await applyChangeSet(fixture, 'fail-old', [{ path: 'b.txt', before: 'b-1', after: 'b-2' }])
    await applyChangeSet(fixture, 'fail-new', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await chmod(workspaceFile('b.txt'), 0o444)

    try {
      const result = await revertBatch(['fail-old', 'fail-new'])

      expect(result.ok).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/^batch rollback stopped at fail-old: /)
      expect(result.error).toContain('failed to restore')
      // 报告里不列已退掉的账——它们已经被补回去了，写进去会让调用方以为不用再管。
      expect(result.revertedChangeSetIds).toEqual([])
      expect(result.conflicts).toEqual([])
      // 磁盘与账本都回到「一条都没退」。
      await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-2')
      await expect(readFile(workspaceFile('b.txt'), 'utf8')).resolves.toBe('b-2')
      expect(await entryStatus('fail-old')).toBe('applied')
      expect(await entryStatus('fail-new')).toBe('applied')
    } finally {
      await chmod(workspaceFile('b.txt'), 0o644)
    }
  })
})
