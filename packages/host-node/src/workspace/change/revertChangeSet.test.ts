// 整文件改写（write / patch 记的那类账）的回滚，外加 dryRun 与四道前置关卡。
// 路径搬运类的账（删除 / 复制 / 移动）在 revertChangeSetPaths.test.ts——两类账的还原方式、
// 冲突判据与失败形态都不一样，混在一个文件里既读不清也必然顶破行数。
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { revertChangeSet } from './revertChangeSet'
import {
  applyChangeSet,
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

async function revert(changeId: string, dryRun = false) {
  return revertChangeSet(fixture.journal, changeId, dryRun, fixture.root)
}

describe('revertChangeSet 的整文件改写', () => {
  it('撤销一次新建：文件被删掉，再撤一次是 already_reverted', async () => {
    await writeFile(workspaceFile('new.txt'), 'new')
    await applyChangeSet(fixture, 'create-1', [{ path: 'new.txt', before: null, after: 'new' }])

    const result = await revert('create-1')

    expect(result).toEqual({
      ok: true,
      status: 'reverted',
      restoredFiles: ['new.txt'],
      conflicts: [],
      error: null,
      revertedChangeSetIds: ['create-1'],
    })
    await expect(readdir(fixture.root)).resolves.toEqual([])

    const repeated = await revert('create-1')
    expect(repeated.status).toBe('already_reverted')
    expect(repeated.ok).toBe(true)
    expect(repeated.revertedChangeSetIds).toEqual([])
  })

  it('一条账里的改写/新建/删除三种形态一起还原，顺序就是账上的顺序', async () => {
    await writeFile(workspaceFile('edited.txt'), 'after-edit')
    await writeFile(workspaceFile('created.txt'), 'created')
    await applyChangeSet(fixture, 'multi-file', [
      { path: 'edited.txt', before: 'before-edit', after: 'after-edit' },
      { path: 'created.txt', before: null, after: 'created' },
      { path: 'deleted.txt', before: 'before-delete', after: null },
    ])

    const result = await revert('multi-file')

    expect(result.ok).toBe(true)
    expect(result.restoredFiles).toEqual(['edited.txt', 'created.txt', 'deleted.txt'])
    await expect(readFile(workspaceFile('edited.txt'), 'utf8')).resolves.toBe('before-edit')
    await expect(readdir(fixture.root)).resolves.toEqual(['deleted.txt', 'edited.txt'])
    await expect(readFile(workspaceFile('deleted.txt'), 'utf8')).resolves.toBe('before-delete')
  })

  it('任一文件被人动过就整条拒绝，一个字节都不写', async () => {
    await writeFile(workspaceFile('a.txt'), 'after-a')
    await writeFile(workspaceFile('b.txt'), 'user-edit')
    await applyChangeSet(fixture, 'conflict-1', [
      { path: 'a.txt', before: 'before-a', after: 'after-a' },
      { path: 'b.txt', before: 'before-b', after: 'after-b' },
    ])

    const result = await revert('conflict-1')

    expect(result.ok).toBe(false)
    expect(result.status).toBe('conflict')
    expect(result.error).toBeNull()
    expect(result.conflicts).toEqual([
      { path: 'b.txt', reason: 'file changed after the original tool call' },
    ])
    // 冲突在 a.txt 之后被发现，但 a.txt 同样不能被改——预检通过之前一条盘都不碰。
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('after-a')
    await expect(readFile(workspaceFile('b.txt'), 'utf8')).resolves.toBe('user-edit')
  })

  it('连续两次改动必须先退新的：先退老的会被冲突挡住', async () => {
    const path = workspaceFile('value.txt')
    await writeFile(path, 'version-3')
    await applyChangeSet(fixture, 'change-1', [
      { path: 'value.txt', before: 'version-1', after: 'version-2' },
    ])
    await applyChangeSet(fixture, 'change-2', [
      { path: 'value.txt', before: 'version-2', after: 'version-3' },
    ])

    const outOfOrder = await revert('change-1')
    expect(outOfOrder.ok).toBe(false)
    expect(outOfOrder.status).toBe('conflict')
    await expect(readFile(path, 'utf8')).resolves.toBe('version-3')

    expect((await revert('change-2')).ok).toBe(true)
    await expect(readFile(path, 'utf8')).resolves.toBe('version-2')
    expect((await revert('change-1')).ok).toBe(true)
    await expect(readFile(path, 'utf8')).resolves.toBe('version-1')
  })

  it('执行中途写不下去时把已还原的文件补回原样，条目状态仍是 applied', async () => {
    // 第二个文件设成只读：预检读得到，写回时才失败——这正是「预检通过、执行失败」那条路径。
    const guarded = workspaceFile('second.txt')
    await writeFile(workspaceFile('first.txt'), 'after-first')
    await writeFile(guarded, 'after-second')
    await applyChangeSet(fixture, 'partial-1', [
      { path: 'first.txt', before: 'before-first', after: 'after-first' },
      { path: 'second.txt', before: 'before-second', after: 'after-second' },
    ])
    await chmod(guarded, 0o444)

    try {
      const result = await revert('partial-1')

      expect(result.ok).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.error).toContain('failed to restore')
      expect(result.restoredFiles).toEqual([])
      // 补偿：第一个文件回到 after，等于「这次回滚没发生过」。
      await expect(readFile(workspaceFile('first.txt'), 'utf8')).resolves.toBe('after-first')
      await expect(readFile(guarded, 'utf8')).resolves.toBe('after-second')
      const entry = JSON.parse(await readFile(join(fixture.journal, 'partial-1.json'), 'utf8'))
      expect(entry.status).toBe('applied')
    } finally {
      await chmod(guarded, 0o644)
    }
  })
})

describe('revertChangeSet 的 dryRun 与前置关卡', () => {
  it('dryRun 跑完整套冲突检测，报告与真跑一致，但一条盘都不碰、状态不变', async () => {
    await writeFile(workspaceFile('a.txt'), 'after-a')
    await applyChangeSet(fixture, 'dry-1', [{ path: 'a.txt', before: 'before-a', after: 'after-a' }])

    const preview = await revert('dry-1', true)

    expect(preview).toEqual({
      ok: true,
      status: 'ready',
      restoredFiles: ['a.txt'],
      conflicts: [],
      error: null,
      revertedChangeSetIds: [],
    })
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('after-a')
    const entry = JSON.parse(await readFile(join(fixture.journal, 'dry-1.json'), 'utf8'))
    expect(entry.status).toBe('applied')

    // 同一条账真跑：restoredFiles 与预演逐字相同，只有 status / ids 变了。
    const real = await revert('dry-1')
    expect(real.restoredFiles).toEqual(preview.restoredFiles)
    expect(real.status).toBe('reverted')
    expect(real.revertedChangeSetIds).toEqual(['dry-1'])
  })

  it('dryRun 同样会报冲突——它是预演，不是「只校验 id」', async () => {
    await writeFile(workspaceFile('a.txt'), 'user-edit')
    await applyChangeSet(fixture, 'dry-2', [{ path: 'a.txt', before: 'before-a', after: 'after-a' }])

    const result = await revert('dry-2', true)

    expect(result.ok).toBe(false)
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toHaveLength(1)
  })

  it('账不属于这个 workspace 时拒绝，且早于任何冲突检测', async () => {
    await writeFile(workspaceFile('a.txt'), 'after-a')
    await applyChangeSet(fixture, 'other-ws', [
      { path: 'a.txt', before: 'before-a', after: 'after-a' },
    ])
    const elsewhere = await createChangeJournalFixture()

    try {
      const result = await revertChangeSet(fixture.journal, 'other-ws', false, elsewhere.root)
      expect(result).toEqual({
        ok: false,
        status: 'workspace_mismatch',
        restoredFiles: [],
        conflicts: [],
        error: 'change set belongs to a different workspace',
        revertedChangeSetIds: [],
      })
    } finally {
      await elsewhere.cleanup()
    }
  })

  it('非法 change id 直接抛，不去碰日志目录', async () => {
    await expect(revert('../escape')).rejects.toThrow('invalid workspace change id')
  })

  it('条目不存在时抛的是「读不到」，不是一个 ok:false 的回执', async () => {
    await expect(revert('missing-1')).rejects.toThrow('failed to read change set `missing-1`')
  })
})
