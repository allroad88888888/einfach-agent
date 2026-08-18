import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteFixture, type WriteFixture } from './pipeline.testHarness'
import { REVERSIBLE_MAX_BYTES } from './limits'
import type { WorkspaceChangeContext, WorkspaceChangeSet } from '../change/types'

let fixture: WriteFixture

beforeEach(async () => {
  fixture = await createWriteFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const context = (changeId: string): WorkspaceChangeContext => ({
  changeId,
  sessionId: 'session',
  runId: 'run',
  toolCallId: 'call',
})

async function readEntry(changeId: string): Promise<WorkspaceChangeSet> {
  return JSON.parse(await readFile(join(fixture.journal, `${changeId}.json`), 'utf8')) as WorkspaceChangeSet
}

async function journalEntries(): Promise<string[]> {
  return readdir(fixture.journal).catch(() => [])
}

describe('变更日志', () => {
  it('带 changeContext 的写入在动手之前记账，成功后标记 applied', async () => {
    const result = await fixture.write({
      path: 'new.txt',
      content: 'content',
      changeContext: context('write-change'),
    })
    expect(result.ok).toBe(true)
    expect(result.change_set).toEqual({ id: 'write-change', reversible: true })

    const entry = await readEntry('write-change')
    expect(entry.status).toBe('applied')
    expect(entry.files).toHaveLength(1)
    // 账里存的是根相对路径与改前/改后的完整文本——回滚只认这份记录。
    expect(entry.files[0].path).toBe('new.txt')
    expect(entry.files[0].before).toEqual({ exists: false, hash: null, content: null })
    expect(entry.files[0].after.content).toBe('content')
  })

  it('覆盖时账里的 before 是磁盘上原来的内容', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'old\n')
    await fixture.write({
      path: 'code.txt',
      content: 'new\n',
      mode: 'overwrite',
      changeContext: context('overwrite-change'),
    })
    const entry = await readEntry('overwrite-change')
    expect(entry.files[0].before.content).toBe('old\n')
    expect(entry.files[0].after.content).toBe('new\n')
  })

  it('append 记的是**整个文件**的前后样子，不是只记追加的那段', async () => {
    await writeFile(join(fixture.root, 'log.txt'), 'one\n')
    await fixture.write({
      path: 'log.txt',
      content: 'two\n',
      mode: 'append',
      changeContext: context('append-change'),
    })
    const entry = await readEntry('append-change')
    expect(entry.files[0].before.content).toBe('one\n')
    expect(entry.files[0].after.content).toBe('one\ntwo\n')
  })

  it('不带 changeContext 就是一次不可回滚的直接写：一条账都不留', async () => {
    const result = await fixture.write({ path: 'a.txt', content: 'x' })
    expect(result.ok).toBe(true)
    expect(result.change_set).toBeNull()
    expect(await journalEntries()).toEqual([])
  })

  it('dry run 预留的账当场丢掉', async () => {
    const result = await fixture.write({
      path: 'a.txt',
      content: 'x',
      dryRun: true,
      changeContext: context('dry-change'),
    })
    expect(result.ok).toBe(true)
    expect(result.change_set).toBeNull()
    expect(await journalEntries()).toEqual([])
  })

  it('写入失败时预留的账被丢掉，不留孤儿条目', async () => {
    // 让父路径是一个**文件**：父目录「存在」所以不会去建，落盘时内核给 ENOTDIR。
    // 这是不靠权限、不靠磁盘满就能稳定造出「记账成功但写失败」的一条路径。
    await writeFile(join(fixture.root, 'blocker.txt'), 'x')
    const result = await fixture.write({
      path: 'blocker.txt/child.txt',
      content: 'x',
      changeContext: context('failed-change'),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(await journalEntries()).toEqual([])
  })

  it('不可逆的写入不记账——回滚要靠完整前后文本，而那正是它拿不到的', async () => {
    const result = await fixture.write({
      path: 'big.txt',
      content: 'x'.repeat(REVERSIBLE_MAX_BYTES + 1),
      changeContext: context('big-change'),
    })
    expect(result.ok).toBe(true)
    expect(result.reversible).toBe(false)
    expect(result.change_set).toBeNull()
    expect(await journalEntries()).toEqual([])
  })

  it('同一个 changeId 记两次会被拒，且第二次不落盘', async () => {
    await fixture.write({ path: 'a.txt', content: '1', changeContext: context('dup') })
    const second = await fixture.write({ path: 'b.txt', content: '2', changeContext: context('dup') })
    expect(second.ok).toBe(false)
    expect(second.error).toBe('workspace change id already exists')
    expect(await journalEntries()).toEqual(['dup.json'])
  })
})
