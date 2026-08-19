import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDeleteWorkspacePathHandler,
  narrowDeleteWorkspacePathArgs,
} from './deleteWorkspacePathHandler'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { WorkspaceDeleteResult } from './result'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('narrowDeleteWorkspacePathArgs', () => {
  it('顶层键是 snake_case，change_context 的值内部是 camelCase', () => {
    // 一个对象里两种命名规则并存，是这条命令最容易踩的一处。
    expect(
      narrowDeleteWorkspacePathArgs({
        path: 'build',
        recursive: true,
        workspace_root: '/tmp/ws',
        change_context: {
          changeId: 'chg',
          sessionId: 'sess',
          runId: 'run',
          toolCallId: 'call',
        },
      }),
    ).toEqual({
      path: 'build',
      recursive: true,
      workspaceRoot: '/tmp/ws',
      changeContext: { changeId: 'chg', sessionId: 'sess', runId: 'run', toolCallId: 'call' },
    })
  })

  it('键存在但值为 undefined / null 一律当没给', () => {
    // core 的 toTauriInput 整份对象字面量返回，可选项无值时键存在且为 undefined；走 HTTP 时
    // JSON.stringify 又把它丢掉。用 `'key' in args` 判存在会写出「本地能跑、上 server 就变」。
    const narrowed = narrowDeleteWorkspacePathArgs({
      path: 'a.txt',
      recursive: undefined,
      workspace_root: null,
      change_context: undefined,
    })
    expect(narrowed.recursive).toBeUndefined()
    expect(narrowed.workspaceRoot).toBeUndefined()
    expect(narrowed.changeContext).toBeUndefined()
  })

  it.each([
    ['path 缺失', {}],
    ['path 不是字符串', { path: 5 }],
    ['recursive 不是布尔', { path: 'a.txt', recursive: 'yes' }],
    ['workspace_root 不是字符串', { path: 'a.txt', workspace_root: 7 }],
    ['change_context 不是对象', { path: 'a.txt', change_context: 'chg' }],
    ['change_context 是数组', { path: 'a.txt', change_context: [] }],
    ['change_context 少字段', { path: 'a.txt', change_context: { changeId: 'chg' } }],
    [
      'change_context 用了 snake_case 字段名',
      { path: 'a.txt', change_context: { change_id: 'chg', session_id: 's', run_id: 'r', tool_call_id: 'c' } },
    ],
  ])('类型不对是 rejection 而不是回执（%s）', (_label, args) => {
    // Rust 侧这种情况在 serde 反序列化时就失败了，调用方拿到的是一次 invoke 失败。
    expect(() => narrowDeleteWorkspacePathArgs(args as Record<string, unknown>)).toThrow()
  })
})

describe('createDeleteWorkspacePathHandler', () => {
  it('handler 收 snake_case 入参、真删磁盘、回执键也是 snake_case', async () => {
    // homeDir 指向临时目录，日志才不会落到真实的 ~/Library/Application Support 下。
    const handler = createDeleteWorkspacePathHandler({ homeDir: workspace.base })
    await writeFile(join(workspace.root, 'note.txt'), 'x')

    const result = (await handler({
      path: 'note.txt',
      workspace_root: workspace.root,
      change_context: { changeId: 'chg', sessionId: 's', runId: 'r', toolCallId: 'c' },
    })) as WorkspaceDeleteResult

    expect(result.ok).toBe(true)
    expect(result.change_set).toEqual({ id: 'chg', reversible: true })
    await expect(readFile(join(workspace.root, 'note.txt'), 'utf8')).rejects.toThrow()
  })

  it('按设计的拒绝是 ok:false 的回执，不是 rejection——模型要读得到那句话', async () => {
    const handler = createDeleteWorkspacePathHandler({ homeDir: workspace.base })
    const result = (await handler({
      path: 'missing.txt',
      workspace_root: workspace.root,
    })) as WorkspaceDeleteResult

    expect(result.ok).toBe(false)
    expect(result.deleted).toBe(false)
    expect(result.error).toContain('failed to resolve target path')
  })
})
