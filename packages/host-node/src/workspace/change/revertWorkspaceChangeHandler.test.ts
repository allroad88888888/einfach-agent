import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  narrowRevertWorkspaceChangeArgs,
  revertWorkspaceChange,
} from './revertWorkspaceChangeHandler'
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

describe('narrowRevertWorkspaceChangeArgs', () => {
  it('顶层键是 snake_case，收窄后转成本包内部的 camelCase', () => {
    expect(
      narrowRevertWorkspaceChangeArgs({
        change_set_id: 'chg-1',
        change_set_ids: ['chg-1', 'chg-2'],
        dry_run: true,
        workspace_root: '/ws',
      }),
    ).toEqual({
      changeSetId: 'chg-1',
      changeSetIds: ['chg-1', 'chg-2'],
      dryRun: true,
      workspaceRoot: '/ws',
    })
  })

  it('键存在但值为 undefined 与整个键缺席等价（HTTP 传输会把前者变成后者）', () => {
    const withUndefined = narrowRevertWorkspaceChangeArgs({
      change_set_id: 'chg-1',
      change_set_ids: undefined,
      dry_run: undefined,
      workspace_root: undefined,
    })
    expect(withUndefined).toEqual(narrowRevertWorkspaceChangeArgs({ change_set_id: 'chg-1' }))
  })

  it('null 与缺席同义（serde 的 Option 三者一样）', () => {
    expect(narrowRevertWorkspaceChangeArgs({ change_set_id: null }).changeSetId).toBeUndefined()
  })

  it('类型不对当场拒，不让它一路跑到文件系统调用里', () => {
    expect(() => narrowRevertWorkspaceChangeArgs({ change_set_id: 7 })).toThrow(
      'revert_workspace_change 的 change_set_id 必须是字符串',
    )
    expect(() => narrowRevertWorkspaceChangeArgs({ change_set_ids: ['a', 7] })).toThrow(
      'revert_workspace_change 的 change_set_ids 必须是字符串数组',
    )
    expect(() => narrowRevertWorkspaceChangeArgs({ dry_run: 'yes' })).toThrow(
      'revert_workspace_change 的 dry_run 必须是布尔值',
    )
  })
})

describe('revertWorkspaceChange 的单/批分派', () => {
  beforeEach(async () => {
    await writeFile(workspaceFile('a.txt'), 'a-2')
    await writeFile(workspaceFile('b.txt'), 'b-2')
    await applyChangeSet(fixture, 'one', [{ path: 'a.txt', before: 'a-1', after: 'a-2' }])
    await applyChangeSet(fixture, 'two', [{ path: 'b.txt', before: 'b-1', after: 'b-2' }])
  })

  it('给单个 id 走单条路径（status 是 reverted）', async () => {
    const result = await revertWorkspaceChange(fixture.journal, {
      changeSetId: 'one',
      workspaceRoot: fixture.root,
    })

    expect(result.status).toBe('reverted')
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-1')
  })

  it('给两个 id 走批量路径（status 是 batch_reverted）', async () => {
    const result = await revertWorkspaceChange(fixture.journal, {
      changeSetIds: ['one', 'two'],
      workspaceRoot: fixture.root,
    })

    expect(result.status).toBe('batch_reverted')
    expect(result.revertedChangeSetIds).toEqual(['two', 'one'])
  })

  it('单元素数组走的仍是**单条**路径——分派看的是有效 id 数量，不是用了哪个参数', async () => {
    const result = await revertWorkspaceChange(fixture.journal, {
      changeSetIds: ['one'],
      workspaceRoot: fixture.root,
    })

    expect(result.status).toBe('reverted')
    expect(result.revertedChangeSetIds).toEqual(['one'])
  })

  it('空数组等同没给，退回 change_set_id', async () => {
    const result = await revertWorkspaceChange(fixture.journal, {
      changeSetId: 'one',
      changeSetIds: [],
      workspaceRoot: fixture.root,
    })

    expect(result.status).toBe('reverted')
  })

  it('两个 id 参数都没给时抛 Rust 那句原文', async () => {
    await expect(
      revertWorkspaceChange(fixture.journal, { workspaceRoot: fixture.root }),
    ).rejects.toThrow('change_set_id or change_set_ids is required')
  })

  it('workspace root 解析失败早于「没给 id」——根都不对时先说根', async () => {
    await expect(
      revertWorkspaceChange(fixture.journal, { workspaceRoot: join(fixture.root, 'missing') }),
    ).rejects.toThrow('failed to resolve workspace root')
  })

  it('dryRun 透传下去：什么都不改', async () => {
    const result = await revertWorkspaceChange(fixture.journal, {
      changeSetId: 'one',
      dryRun: true,
      workspaceRoot: fixture.root,
    })

    expect(result.status).toBe('ready')
    await expect(readFile(workspaceFile('a.txt'), 'utf8')).resolves.toBe('a-2')
  })
})
