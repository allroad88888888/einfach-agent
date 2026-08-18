// `read_workspace_file` 选路与原始入参收窄的用例。
// 只测「这一次请求落到哪条实现上、以及哪些值算传了」——两条实现各自的语义在
// bytesRead.test.ts / linesRead.test.ts。
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadWorkspaceFileHandler } from './linesDispatch'
import type { ReadWorkspaceFileResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function read(args: Record<string, unknown>): Promise<ReadWorkspaceFileResult> {
  return createReadWorkspaceFileHandler({})({
    workspace_root: workspace.root,
    ...args,
  }) as Promise<ReadWorkspaceFileResult>
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.root, 'code.rs'), 'a\nb\nc\n')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('read_workspace_file：字节模式与行模式的选路', () => {
  it('两个行参数都不给 → 字节模式，四个行字段一个都不出现', async () => {
    const result = await read({ path: 'code.rs', max_bytes: 2, offset: 0 })
    expect(result).toMatchObject({ content: 'a\n', nextOffset: 2 })
    for (const key of ['startLine', 'endLine', 'nextLine', 'totalLines']) {
      expect(key in result).toBe(false)
    }
  })

  it('只给 line_count 也是行模式，起始行默认第 1 行', async () => {
    await expect(read({ path: 'code.rs', line_count: 2 })).resolves.toMatchObject({
      content: 'a\nb\n',
      startLine: 1,
      endLine: 2,
      nextLine: 3,
      totalLines: 3,
    })
  })

  it('只给 start_line 也是行模式，读到文件末尾', async () => {
    await expect(read({ path: 'code.rs', start_line: 2 })).resolves.toMatchObject({
      content: 'b\nc\n',
      startLine: 2,
      totalLines: 3,
    })
  })
})

describe('read_workspace_file：startLine 与非零 offset 互斥', () => {
  const conflict = 'pass either offset or startLine, not both; use nextLine to continue a line read'

  it('start_line 加非零 offset → 整体拒绝（不是让某一个游标胜出）', async () => {
    await expect(read({ path: 'code.rs', start_line: 1, offset: 2 })).rejects.toThrow(conflict)
  })

  it('冲突判定只看 offset：只给 line_count 加非零 offset 同样被拒', async () => {
    // 文案说的是 "startLine"，而触发它的是 lineCount。措辞与判据不完全贴合是 Rust 侧的
    // 现状，照搬不改——错误文案是两个宿主的对外契约。
    await expect(read({ path: 'code.rs', line_count: 1, offset: 1 })).rejects.toThrow(conflict)
  })

  it('offset: 0 不算「传了 offset」，与不传等价', async () => {
    await expect(read({ path: 'code.rs', start_line: 2, offset: 0 })).resolves.toMatchObject({
      content: 'b\nc\n',
      startLine: 2,
    })
  })

  it('冲突判定先于文件系统：路径不存在也先报冲突', async () => {
    await expect(read({ path: 'nope.txt', start_line: 1, offset: 5 })).rejects.toThrow(conflict)
  })
})

describe('read_workspace_file：原始入参的收窄', () => {
  it('start_line: 0 算「传了一个非法值」→ 进行模式，报 1-based', async () => {
    await expect(read({ path: 'code.rs', start_line: 0 })).rejects.toThrow('startLine is 1-based')
  })

  it('line_count: 0 同理 → 进行模式，报 greater than 0', async () => {
    await expect(read({ path: 'code.rs', line_count: 0 })).rejects.toThrow(
      'lineCount must be greater than 0',
    )
  })

  it('负数 / 小数 / 字符串的行参数当作没传 → 回落字节模式，不整体拒绝', async () => {
    for (const bogus of [-1, 1.5, '2', null, true]) {
      const result = await read({ path: 'code.rs', start_line: bogus, line_count: bogus })
      expect(result.content).toBe('a\nb\nc\n')
      expect('totalLines' in result).toBe(false)
    }
  })

  it('非法的 offset 当作没传，因此不与行参数冲突', async () => {
    await expect(read({ path: 'code.rs', start_line: 2, offset: -3 })).resolves.toMatchObject({
      content: 'b\nc\n',
    })
  })

  it('max_bytes 非法（0 / 负数 / 非数字）时回落默认上限，不整体拒绝', async () => {
    for (const bogus of [0, -5, 'big']) {
      await expect(read({ path: 'code.rs', start_line: 1, max_bytes: bogus })).resolves.toMatchObject(
        { content: 'a\nb\nc\n' },
      )
    }
  })
})
