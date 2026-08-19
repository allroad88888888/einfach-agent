// `read_workspace_run_index_page` 的端到端用例，对齐
// apps/desktop/src/workspace_read_run_index_tests.rs（已随 T1 删除）。一律经 handler 工厂调用——理由同
// bytesRead.test.ts：绕过工厂直接测内部函数会漏掉「工厂没把 args 透传下去」这类错误。
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadWorkspaceRunIndexPageHandler } from './runIndexRead'
import { MAX_RUN_INDEX_BYTES, RUNS_INDEX_PATH } from './limits'
import type { ReadWorkspaceRunIndexPageResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function readPage(args: Record<string, unknown> = {}): Promise<ReadWorkspaceRunIndexPageResult> {
  return createReadWorkspaceRunIndexPageHandler({})({
    workspace_root: workspace.root,
    ...args,
  }) as Promise<ReadWorkspaceRunIndexPageResult>
}

async function seedIndex(content: string): Promise<void> {
  const dir = join(workspace.root, '.webAgent-archive', 'index')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'runs.jsonl'), content)
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('read_workspace_run_index_page：找不到索引文件', () => {
  it('索引目录不存在时报「not accessible」，不是当作空索引', async () => {
    await expect(readPage()).rejects.toThrow(/is not accessible in workspace/)
  })
})

describe('read_workspace_run_index_page：从文件尾向前分页', () => {
  it('大量唯一记录也不截断，且逐页给出新→旧顺序', async () => {
    const records = Array.from({ length: 4_000 }, (_, index) =>
      JSON.stringify({ conversationId: `c-${index}`, runId: `r-${index}`, padding: 'x'.repeat(32) }),
    )
    const content = `${records.join('\n')}\n`
    expect(content.length).toBeGreaterThan(200_000) // 超过通用读取上限，验证走的是独立上限
    await seedIndex(content)

    const first = await readPage({ max_records: 2 })
    expect(first.lines).toHaveLength(2)
    expect(first.lines[0]).toEqual({ lineNumber: 4_000, content: records[3_999] })
    expect(first.lines[1]).toEqual({ lineNumber: 3_999, content: records[3_998] })
    expect(first.hasMore).toBe(true)
    expect(first.cursor).toBeDefined()
    expect(first.path).toBe(RUNS_INDEX_PATH)

    const second = await readPage({ max_records: 2, cursor: first.cursor })
    expect(second.lines[0]).toEqual({ lineNumber: 3_998, content: records[3_997] })
    expect(second.snapshot).toBe(first.snapshot)
  })

  it('翻到底时不带 cursor 键，hasMore 为 false', async () => {
    await seedIndex('{"runId":"r1"}\n{"runId":"r2"}\n')
    const page = await readPage({ max_records: 10 })
    expect(page.lines).toHaveLength(2)
    expect(page.hasMore).toBe(false)
    expect('cursor' in page).toBe(false)
  })

  it('空文件是 0 行，返回空页且不是「读到一行空字符串」', async () => {
    await seedIndex('')
    const page = await readPage()
    expect(page.lines).toEqual([])
    expect(page.hasMore).toBe(false)
    expect('cursor' in page).toBe(false)
  })

  it('空白行跳过但仍占用行号预算，不出现在结果里', async () => {
    await seedIndex('{"runId":"r1"}\n\n   \n{"runId":"r2"}\n')
    const page = await readPage({ max_records: 10 })
    expect(page.lines).toEqual([
      { lineNumber: 4, content: '{"runId":"r2"}' },
      { lineNumber: 1, content: '{"runId":"r1"}' },
    ])
  })

  it('最后一行没有换行符仍然算一行', async () => {
    await seedIndex('{"runId":"r1"}\n{"runId":"r2"}')
    const page = await readPage({ max_records: 10 })
    expect(page.lines).toEqual([
      { lineNumber: 2, content: '{"runId":"r2"}' },
      { lineNumber: 1, content: '{"runId":"r1"}' },
    ])
  })

  it('分页游标越过一批空白行后正确衔接，不重复不遗漏', async () => {
    await seedIndex('{"a":1}\n{"a":2}\n{"a":3}\n')
    const first = await readPage({ max_records: 1 })
    expect(first.lines).toEqual([{ lineNumber: 3, content: '{"a":3}' }])
    const second = await readPage({ max_records: 1, cursor: first.cursor })
    expect(second.lines).toEqual([{ lineNumber: 2, content: '{"a":2}' }])
    const third = await readPage({ max_records: 1, cursor: second.cursor })
    expect(third.lines).toEqual([{ lineNumber: 1, content: '{"a":1}' }])
    expect(third.hasMore).toBe(false)
    expect('cursor' in third).toBe(false)
  })
})

describe('read_workspace_run_index_page：游标校验', () => {
  it('文件在两次分页之间被追加时，旧游标失败关闭', async () => {
    await seedIndex('{"runId":"r1"}\n{"runId":"r2"}\n')
    const first = await readPage({ max_records: 1 })
    await writeFile(
      join(workspace.root, RUNS_INDEX_PATH),
      '{"runId":"r3"}\n',
      { flag: 'a' },
    )
    await expect(readPage({ max_records: 1, cursor: first.cursor })).rejects.toThrow(
      /changed while paging/,
    )
  })

  it('文件被 compact 替换（原子 rename）后，旧游标失败关闭', async () => {
    await seedIndex('{"runId":"old"}\n{"runId":"latest"}\n')
    const first = await readPage({ max_records: 1 })
    const replacement = join(workspace.root, '.webAgent-archive', 'index', 'runs.jsonl.compact.tmp')
    await writeFile(replacement, '{"runId":"latest"}\n')
    await rename(replacement, join(workspace.root, RUNS_INDEX_PATH))
    await expect(readPage({ max_records: 1, cursor: first.cursor })).rejects.toThrow(
      /changed while paging/,
    )
  })

  it('游标缺少冒号即视为非法格式', async () => {
    await seedIndex('{"runId":"r1"}\n')
    await expect(readPage({ cursor: 'not-a-cursor' })).rejects.toThrow(/cursor is invalid/)
  })

  it('游标版本前缀不是 v1- 时给出「版本不受支持」', async () => {
    await seedIndex('{"runId":"r1"}\n')
    await expect(readPage({ cursor: 'v2-0-abc:0' })).rejects.toThrow(/version is unsupported/)
  })

  it('游标的 before 段不是纯数字时视为非法格式', async () => {
    await seedIndex('{"runId":"r1"}\n')
    const page = await readPage({ max_records: 1 })
    const snapshot = page.snapshot
    await expect(readPage({ cursor: `${snapshot}:1abc` })).rejects.toThrow(/cursor is invalid/)
    await expect(readPage({ cursor: `${snapshot}:-1` })).rejects.toThrow(/cursor is invalid/)
  })

  it('游标的 before 超过当前总行数时视为越界', async () => {
    await seedIndex('{"runId":"r1"}\n')
    const page = await readPage({ max_records: 1 })
    await expect(readPage({ cursor: `${page.snapshot}:99` })).rejects.toThrow(/out of range/)
  })
})

describe('read_workspace_run_index_page：容量上限', () => {
  it('超过 MAX_RUN_INDEX_BYTES 时整体拒绝', async () => {
    await seedIndex('x'.repeat(MAX_RUN_INDEX_BYTES + 1))
    await expect(readPage()).rejects.toThrow(/exceeds the .* byte safety limit/)
  })

  it('含 NUL 字节的索引文件按二进制拒读', async () => {
    const dir = join(workspace.root, '.webAgent-archive', 'index')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'runs.jsonl'), Buffer.from([0x7b, 0x00, 0x7d]))
    await expect(readPage()).rejects.toThrow(/refusing to read binary file/)
  })
})

describe('read_workspace_run_index_page：maxRecords 归一化', () => {
  it('不传 max_records 时回落默认值 50', async () => {
    const records = Array.from({ length: 60 }, (_, index) => JSON.stringify({ runId: `r-${index}` }))
    await seedIndex(`${records.join('\n')}\n`)
    const page = await readPage()
    expect(page.lines).toHaveLength(50)
    expect(page.hasMore).toBe(true)
  })

  it('max_records: 0 视为没传，回落默认值', async () => {
    await seedIndex('{"runId":"r1"}\n{"runId":"r2"}\n')
    const page = await readPage({ max_records: 0 })
    expect(page.lines).toHaveLength(2)
  })
})
