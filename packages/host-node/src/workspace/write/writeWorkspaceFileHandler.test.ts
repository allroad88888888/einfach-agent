import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createWriteWorkspaceFileHandler,
  narrowWriteWorkspaceFileArgs,
} from './writeWorkspaceFileHandler'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { WorkspaceWriteResult } from './result'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('narrowWriteWorkspaceFileArgs', () => {
  it('顶层键是 snake_case，change_context 的值内部是 camelCase', () => {
    // 一个对象里两种命名规则并存，是这条命令最容易踩的一处。
    expect(
      narrowWriteWorkspaceFileArgs({
        path: 'a.txt',
        content: 'x',
        mode: 'overwrite',
        expected_old_content: 'old',
        create_dirs: false,
        max_bytes: 1024,
        exclusive_path_lock: true,
        workspace_root: '/tmp/ws',
        encoding: 'utf8',
        executable: true,
        dry_run: true,
        change_context: {
          changeId: 'chg',
          sessionId: 'sess',
          runId: 'run',
          toolCallId: 'call',
        },
      }),
    ).toEqual({
      path: 'a.txt',
      content: 'x',
      mode: 'overwrite',
      expectedOldContent: 'old',
      expectedContentHash: undefined,
      createDirs: false,
      maxBytes: 1024,
      exclusivePathLock: true,
      workspaceRoot: '/tmp/ws',
      encoding: 'utf8',
      executable: true,
      dryRun: true,
      changeContext: { changeId: 'chg', sessionId: 'sess', runId: 'run', toolCallId: 'call' },
    })
  })

  it('键存在但值为 undefined / null 一律当没给', () => {
    // core 的 toTauriInput 整份对象字面量返回，可选项无值时键存在且为 undefined；走 HTTP 时
    // JSON.stringify 又把它丢掉。用 `'key' in args` 判存在会写出「本地能跑、上 server 就变」。
    const narrowed = narrowWriteWorkspaceFileArgs({
      path: 'a.txt',
      content: 'x',
      mode: undefined,
      dry_run: null,
      change_context: undefined,
    })
    expect(narrowed.mode).toBeUndefined()
    expect(narrowed.dryRun).toBeUndefined()
    expect(narrowed.changeContext).toBeUndefined()
  })

  it.each([
    ['path 缺失', {}],
    ['path 不是字符串', { path: 5, content: 'x' }],
    ['content 缺失', { path: 'a.txt' }],
    ['mode 不是字符串', { path: 'a.txt', content: 'x', mode: 7 }],
    ['dry_run 不是布尔', { path: 'a.txt', content: 'x', dry_run: 'yes' }],
    ['max_bytes 不是数字', { path: 'a.txt', content: 'x', max_bytes: '10' }],
    ['change_context 不是对象', { path: 'a.txt', content: 'x', change_context: 'chg' }],
    [
      'change_context 少字段',
      { path: 'a.txt', content: 'x', change_context: { changeId: 'chg' } },
    ],
  ])('类型不对是 rejection 而不是回执（%s）', (_label, args) => {
    // Rust 侧这种情况在 serde 反序列化时就失败了，调用方拿到的是一次 invoke 失败。
    expect(() => narrowWriteWorkspaceFileArgs(args as Record<string, unknown>)).toThrow()
  })
})

describe('createWriteWorkspaceFileHandler', () => {
  it('handler 收 snake_case 入参、真写磁盘、回执键也是 snake_case', async () => {
    const handler = createWriteWorkspaceFileHandler({ homeDir: workspace.base })
    const result = (await handler({
      path: 'out/a.txt',
      content: 'hello',
      workspace_root: workspace.root,
      create_dirs: true,
    })) as WorkspaceWriteResult

    expect(result.ok).toBe(true)
    // `bytes_written` / `dry_run` / `would_change` 是 snake_case——Rust 侧 WorkspaceWriteResult
    // 没有 rename_all，而 read / patch 的结果结构有。这个不一致是照搬的，不是笔误。
    expect(result.bytes_written).toBe(5)
    expect(result.dry_run).toBe(false)
    expect(result.would_change).toBe(true)
    expect(await readFile(join(workspace.root, 'out/a.txt'), 'utf8')).toBe('hello')
  })

  it('按设计的拒绝是 ok:false 的回执，不是 rejection——模型要读得到那句话', async () => {
    const handler = createWriteWorkspaceFileHandler({ homeDir: workspace.base })
    const result = (await handler({
      path: 'absent.txt',
      content: 'x',
      mode: 'overwrite',
      workspace_root: workspace.root,
    })) as WorkspaceWriteResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('upsert')
  })
})
