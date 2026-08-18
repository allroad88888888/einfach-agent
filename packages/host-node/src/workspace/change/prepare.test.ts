import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changePayloadPath,
  discardPreparedChange,
  markChangeApplied,
  prepareChangeSet,
  prepareCreatedPathChange,
  prepareDeletedPathChange,
  prepareRelocatedPathChange,
} from './prepare'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { WorkspaceChangeContext, WorkspaceChangeSet } from './types'

let workspace: TempWorkspace
let journal: string

const context: WorkspaceChangeContext = {
  changeId: 'chg-1',
  sessionId: 'sess-1',
  runId: 'run-1',
  toolCallId: 'call-1',
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  // 刻意指向一个**尚不存在**的子目录：登记要能自己把日志目录建出来，否则第一次改动就没有账。
  journal = join(workspace.base, 'journal')
})

afterEach(async () => {
  await workspace.cleanup()
})

async function readEntryFile(changeId = context.changeId): Promise<WorkspaceChangeSet> {
  return JSON.parse(await readFile(join(journal, `${changeId}.json`), 'utf8')) as WorkspaceChangeSet
}

describe('prepareChangeSet', () => {
  it('一次写文件在动手之前就把改前改后记进日志', async () => {
    const summary = await prepareChangeSet(journal, context, workspace.root, [
      { path: 'src/a.ts', before: 'old', after: 'new' },
    ])

    expect(summary).toEqual({ id: 'chg-1', reversible: true })
    const entry = await readEntryFile()
    expect(entry).toMatchObject({
      id: 'chg-1',
      sessionId: 'sess-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      workspaceRoot: workspace.root,
      status: 'prepared',
    })
    expect(entry.files).toEqual([
      {
        path: 'src/a.ts',
        // sha256("old") / sha256("new")
        before: {
          exists: true,
          hash: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4',
          content: 'old',
        },
        after: {
          exists: true,
          hash: '11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437',
          content: 'new',
        },
      },
    ])
    expect(entry.createdAt).toBeGreaterThan(1_600_000_000_000_000_000)
    expect(Number.isInteger(entry.createdAt)).toBe(true)
  })

  it('落盘之后目录里只有条目文件，没有临时文件残留', async () => {
    await prepareChangeSet(journal, context, workspace.root, [
      { path: 'a', before: null, after: 'x' },
    ])
    expect(await readdir(journal)).toEqual(['chg-1.json'])
  })

  it('空账即拒', async () => {
    await expect(prepareChangeSet(journal, context, workspace.root, [])).rejects.toThrow(
      'cannot journal an empty workspace change',
    )
  })

  it('非法 change id 即拒，且不在磁盘上留下任何东西', async () => {
    await expect(
      prepareChangeSet(journal, { ...context, changeId: '../escape' }, workspace.root, [
        { path: 'a', before: null, after: 'x' },
      ]),
    ).rejects.toThrow('invalid workspace change id')
    await expect(readdir(journal)).rejects.toThrow()
  })

  it('id 已被占用即拒（不覆盖上一次的账）', async () => {
    const files = [{ path: 'a', before: null, after: 'x' }]
    await prepareChangeSet(journal, context, workspace.root, files)
    await expect(prepareChangeSet(journal, context, workspace.root, files)).rejects.toThrow(
      'workspace change id already exists',
    )
  })

  it('两次登记的 createdAt 严格递增（批量回滚按它定顺序）', async () => {
    await prepareChangeSet(journal, context, workspace.root, [
      { path: 'a', before: null, after: 'x' },
    ])
    await prepareChangeSet(journal, { ...context, changeId: 'chg-2' }, workspace.root, [
      { path: 'b', before: null, after: 'y' },
    ])
    expect((await readEntryFile('chg-2')).createdAt).toBeGreaterThan(
      (await readEntryFile('chg-1')).createdAt,
    )
  })
})

describe('prepareDeletedPathChange', () => {
  it('只记路径，内容由调用方另存到载荷路径', async () => {
    await prepareDeletedPathChange(journal, context, workspace.root, 'docs/gone.md')
    const entry = await readEntryFile()
    expect(entry.movedPaths).toEqual([{ path: 'docs/gone.md' }])
    expect(entry.files).toEqual([])
  })

  it('载荷路径已被占用即拒（否则会盖掉上一次删除的唯一副本）', async () => {
    await mkdir(journal, { recursive: true })
    await writeFile(changePayloadPath(journal, context.changeId), 'previous payload')
    await expect(
      prepareDeletedPathChange(journal, context, workspace.root, 'docs/gone.md'),
    ).rejects.toThrow('workspace change id already exists')
    // 上一次的载荷必须原封不动。
    await expect(
      readFile(changePayloadPath(journal, context.changeId), 'utf8'),
    ).resolves.toBe('previous payload')
  })
})

describe('prepareCreatedPathChange / prepareRelocatedPathChange', () => {
  it('复制只填 createdPaths', async () => {
    await prepareCreatedPathChange(journal, context, workspace.root, 'copy.txt', 'fp-1')
    const entry = await readEntryFile()
    expect(entry.createdPaths).toEqual([{ path: 'copy.txt', fingerprint: 'fp-1' }])
    expect(entry.relocatedPaths).toEqual([])
  })

  it('移动只填 relocatedPaths，且记的是 source 与 destination 两端', async () => {
    await prepareRelocatedPathChange(journal, context, workspace.root, 'a.txt', 'b.txt', 'fp-2')
    const entry = await readEntryFile()
    expect(entry.relocatedPaths).toEqual([
      { source: 'a.txt', destination: 'b.txt', fingerprint: 'fp-2' },
    ])
    expect(entry.createdPaths).toEqual([])
  })
})

describe('changePayloadPath', () => {
  it('拼在日志目录下，后缀是 .payload', () => {
    expect(changePayloadPath(journal, 'chg-1')).toBe(join(journal, 'chg-1.payload'))
  })

  it('自己校验 id——它是唯一一个不碰磁盘的入口，指望别人校验就是漏洞', () => {
    expect(() => changePayloadPath(journal, '../../etc/passwd')).toThrow(
      'invalid workspace change id',
    )
  })
})

describe('markChangeApplied', () => {
  it('把状态推到 applied，其余内容一字不改', async () => {
    await prepareChangeSet(journal, context, workspace.root, [
      { path: 'a', before: 'old', after: 'new' },
    ])
    const before = await readEntryFile()

    await markChangeApplied(journal, context.changeId)

    const after = await readEntryFile()
    expect(after.status).toBe('applied')
    expect({ ...after, status: before.status }).toEqual(before)
  })

  it('条目不存在时受控失败', async () => {
    await expect(markChangeApplied(journal, 'chg-missing')).rejects.toThrow(
      'failed to read change set `chg-missing`',
    )
  })

  it('条目内容坏掉时报的是「坏」而不是「读不到」', async () => {
    await mkdir(journal, { recursive: true })
    await writeFile(join(journal, 'chg-1.json'), '{"id":"chg-1"}')
    await expect(markChangeApplied(journal, 'chg-1')).rejects.toThrow('invalid change set `chg-1`')
  })
})

describe('discardPreparedChange', () => {
  it('条目与载荷一起删掉', async () => {
    await prepareDeletedPathChange(journal, context, workspace.root, 'gone.txt')
    await writeFile(changePayloadPath(journal, context.changeId), 'payload')

    await discardPreparedChange(journal, context.changeId)

    expect(await readdir(journal)).toEqual([])
  })

  it('载荷是整棵目录树时也能删掉（删的是目录时就是这种）', async () => {
    await prepareDeletedPathChange(journal, context, workspace.root, 'tree')
    const payload = changePayloadPath(journal, context.changeId)
    await mkdir(join(payload, 'nested'), { recursive: true })
    await writeFile(join(payload, 'nested', 'file.txt'), 'x')

    await discardPreparedChange(journal, context.changeId)

    expect(await readdir(journal)).toEqual([])
  })

  it('什么都不存在时静默返回（它跑在失败路径上，不该盖掉原始错误）', async () => {
    await expect(discardPreparedChange(journal, 'chg-never')).resolves.toBeUndefined()
  })
})
