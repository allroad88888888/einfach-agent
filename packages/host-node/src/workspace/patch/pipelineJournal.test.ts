import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from './pipeline'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { PatchOperation } from './types'
import type { WorkspaceChangeContext, WorkspaceChangeSet } from '../change/types'

let workspace: TempWorkspace
let journal: string

const context: WorkspaceChangeContext = {
  changeId: 'patch-change',
  sessionId: 'session',
  runId: 'run',
  toolCallId: 'call',
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  // 刻意指向一个尚不存在的目录：登记要能自己把它建出来。
  journal = join(workspace.base, 'journal')
})

afterEach(async () => {
  await workspace.cleanup()
})

const path = (name: string) => join(workspace.root, name)
const read = (name: string) => readFile(path(name), 'utf8')

const apply = (operations: PatchOperation[], dryRun = false) =>
  applyPatch({
    operations,
    dryRun,
    workspaceRoot: workspace.root,
    journal: { directory: journal, context },
  })

async function entry(): Promise<WorkspaceChangeSet> {
  return JSON.parse(
    await readFile(join(journal, `${context.changeId}.json`), 'utf8'),
  ) as WorkspaceChangeSet
}

async function journalFiles(): Promise<string[]> {
  return readdir(journal).catch(() => [])
}

describe('applyPatch · 变更日志', () => {
  it('成功的补丁留下一条 applied 的账，改前改后各存一份', async () => {
    await writeFile(path('code.txt'), 'before')

    const result = await apply([
      { type: 'replace', path: 'code.txt', oldText: 'before', newText: 'after' },
    ])

    expect(result.changeSet).toEqual({ id: 'patch-change', reversible: true })
    const recorded = await entry()
    expect(recorded.status).toBe('applied')
    expect(recorded.workspaceRoot).toBe(workspace.root)
    // 记的是**展示路径**（根相对、正斜杠）——回滚按它在 root 下重新解析。
    expect(recorded.files.map((file) => file.path)).toEqual(['code.txt'])
    expect(recorded.files[0]?.before.content).toBe('before')
    expect(recorded.files[0]?.after.content).toBe('after')
  })

  it('记账在落盘之前：登记失败时磁盘一个字都没被改过', async () => {
    // 同名 id 已经在册 → prepareChangeSet 抛错。如果顺序反了（先写再记账），这条断言会看到
    // 已经被改写的 code.txt——那正是「改动已发生、日志没有」的形状，撤不回来且不报错。
    await writeFile(path('code.txt'), 'before')
    await mkdir(journal, { recursive: true })
    await writeFile(join(journal, `${context.changeId}.json`), '{}')

    await expect(
      apply([{ type: 'replace', path: 'code.txt', oldText: 'before', newText: 'after' }]),
    ).rejects.toThrow('workspace change id already exists')

    await expect(read('code.txt')).resolves.toBe('before')
  })

  it('落盘中途失败 → 那条尚未生效的账被丢掉，不留孤儿', async () => {
    await writeFile(path('a.txt'), 'old')
    await writeFile(path('zz'), 'i am a file')

    await expect(
      apply([
        { type: 'overwrite_file', path: 'a.txt', content: 'new', oldContent: 'old' },
        { type: 'add_file', path: 'zz/x.txt', content: 'boom' },
      ]),
    ).rejects.toThrow(/^failed to create parent directory `/)

    // 留着的话，revert 会去还原一次根本没发生的改动。
    expect(await journalFiles()).toEqual([])
    await expect(read('a.txt')).resolves.toBe('old')
  })

  it('dry run 不记账', async () => {
    await writeFile(path('code.txt'), 'before')

    const result = await apply(
      [{ type: 'replace', path: 'code.txt', oldText: 'before', newText: 'after' }],
      true,
    )

    expect(result.changeSet).toBeNull()
    expect(await journalFiles()).toEqual([])
  })

  it('一个文件都没净变化时不记账——没有可撤销的东西', async () => {
    await writeFile(path('same.txt'), 'unchanged')

    const result = await apply([
      { type: 'overwrite_file', path: 'same.txt', content: 'unchanged', oldContent: 'unchanged' },
    ])

    expect(result.ok).toBe(true)
    expect(result.changeSet).toBeNull()
    expect(await journalFiles()).toEqual([])
  })

  it('有操作被拒时不记账', async () => {
    const result = await apply([
      { type: 'replace', path: 'missing.txt', oldText: 'x', newText: 'y' },
    ])

    expect(result.ok).toBe(false)
    expect(result.changeSet).toBeNull()
    expect(await journalFiles()).toEqual([])
  })
})
