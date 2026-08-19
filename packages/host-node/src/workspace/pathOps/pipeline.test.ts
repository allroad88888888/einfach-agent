import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { operateWorkspacePath } from './pipeline'
import { revertChangeSet } from '../change/revertChangeSet'
import {
  changeContext,
  createChangeJournalFixture,
  type ChangeJournalFixture,
} from '../change/changeJournal.testHarness'
import type { WorkspacePathOperationRequest } from './pipeline'

let fixture: ChangeJournalFixture

beforeEach(async () => {
  fixture = await createChangeJournalFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

function at(...segments: string[]): string {
  return join(fixture.root, ...segments)
}

function request(
  source: string,
  destination: string,
  overrides: Partial<WorkspacePathOperationRequest> = {},
): WorkspacePathOperationRequest {
  return {
    source,
    destination,
    workspaceRoot: fixture.root,
    changeContext: changeContext('op-1'),
    ...overrides,
  }
}

// 镜像 apps/desktop/src/workspace_path_ops.rs（已随 T1 删除）的两个 #[cfg(test)] 用例：copy 与 move 各自留下
// 一条能被 `revert_workspace_change` 撤销的账。
describe('operateWorkspacePath: copy', () => {
  it('复制文件并留下一条账；撤销后目标消失、源还在', async () => {
    await writeFile(at('source.txt'), 'content')

    const result = await operateWorkspacePath(
      'copy',
      request('source.txt', 'nested/copied.txt'),
      fixture.journal,
    )

    expect(result.ok).toBe(true)
    expect(result.reversible).toBe(true)
    expect(result.source).toBe('source.txt')
    expect(result.destination).toBe('nested/copied.txt')
    expect(result.changeSet).toEqual({ id: 'op-1', reversible: true })
    await expect(readFile(at('nested', 'copied.txt'), 'utf8')).resolves.toBe('content')

    const reverted = await revertChangeSet(fixture.journal, 'op-1', false, fixture.root)
    expect(reverted.ok).toBe(true)
    await expect(readFile(at('source.txt'), 'utf8')).resolves.toBe('content')
    await expect(readdir(at('nested')).catch(() => [])).resolves.toEqual([])
  })

  it('复制整棵目录树', async () => {
    await mkdir(at('tree', 'inner'), { recursive: true })
    await writeFile(at('tree', 'inner', 'deep.txt'), 'deep')

    const result = await operateWorkspacePath('copy', request('tree', 'copy-of-tree'), fixture.journal)

    expect(result.ok).toBe(true)
    await expect(readFile(at('copy-of-tree', 'inner', 'deep.txt'), 'utf8')).resolves.toBe('deep')
    // 源没动。
    await expect(readFile(at('tree', 'inner', 'deep.txt'), 'utf8')).resolves.toBe('deep')
  })
})

describe('operateWorkspacePath: move', () => {
  it('搬走一个目录并留下一条账；撤销后目标消失、源恢复', async () => {
    await mkdir(at('source'))
    await writeFile(at('source', 'file.txt'), 'content')

    const result = await operateWorkspacePath('move', request('source', 'nested/moved'), fixture.journal)

    expect(result.ok).toBe(true)
    expect(result.reversible).toBe(true)
    await expect(readFile(at('nested', 'moved', 'file.txt'), 'utf8')).resolves.toBe('content')
    await expect(readdir(fixture.root)).resolves.not.toContain('source')

    const reverted = await revertChangeSet(fixture.journal, 'op-1', false, fixture.root)
    expect(reverted.ok).toBe(true)
    await expect(readFile(at('source', 'file.txt'), 'utf8')).resolves.toBe('content')
    await expect(readdir(at('nested')).catch(() => [])).resolves.toEqual([])
  })
})

describe('operateWorkspacePath: 按设计的拒绝', () => {
  it('目标已存在：拒绝，不覆盖，不留账', async () => {
    await writeFile(at('source.txt'), 'a')
    await writeFile(at('dest.txt'), 'b')

    const result = await operateWorkspacePath('copy', request('source.txt', 'dest.txt'), fixture.journal)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('destination already exists')
    // 原样回显调用方传入的字符串，不是解析后的路径。
    expect(result.source).toBe('source.txt')
    expect(result.destination).toBe('dest.txt')
    await expect(readFile(at('dest.txt'), 'utf8')).resolves.toBe('b')
  })

  it('源不存在：拒绝', async () => {
    const result = await operateWorkspacePath('move', request('missing.txt', 'dest.txt'), fixture.journal)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('failed to resolve source')
  })

  it('缺 change_context：拒绝', async () => {
    await writeFile(at('source.txt'), 'a')
    const result = await operateWorkspacePath(
      'copy',
      request('source.txt', 'dest.txt', { changeContext: undefined }),
      fixture.journal,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('path operation requires runtime change context')
  })

  it('.git 元数据：源在 .git 下即拒', async () => {
    await mkdir(at('.git'))
    await writeFile(at('.git', 'config'), 'x')

    const result = await operateWorkspacePath('copy', request('.git/config', 'dest.txt'), fixture.journal)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('path operations refuse Git metadata')
  })

  it('.git 元数据：目标落进 .git 下即拒', async () => {
    await mkdir(at('.git'))
    await writeFile(at('source.txt'), 'a')

    const result = await operateWorkspacePath(
      'copy',
      request('source.txt', '.git/stolen.txt'),
      fixture.journal,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('path operations refuse Git metadata')
  })
})
