import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitRoutes } from './index'
import { createGitWorkspace } from './gitWorkspace.testHarness'
import type { TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createGitWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

/** 直接拿 registrar 交出来的 handler 测——接线（createNodeHostInvoke）由主会话统一做。 */
function gitHandler() {
  const handler = createGitRoutes({}).get_workspace_diff
  if (!handler) throw new Error('registrar 没有交出 get_workspace_diff')
  return handler
}

describe('createGitRoutes', () => {
  it('只负责 get_workspace_diff 一条', () => {
    expect(Object.keys(createGitRoutes({}))).toEqual(['get_workspace_diff'])
  })

  it('顶层键是 snake_case，返回值的键也是（与 Rust 的 serde 输出逐字段一致）', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')

    const result = (await gitHandler()({
      workspace_root: workspace.root,
      paths: ['a.txt'],
      include_stat: true,
      staged: false,
      max_diff_chars: 20_000,
    })) as Record<string, unknown>

    expect(Object.keys(result).sort()).toEqual([
      'base',
      'changed_files',
      'diff',
      'exit_code',
      'stat',
      'status_short',
      'stderr',
      'truncated',
    ])
    expect(result.exit_code).toBe(0)
    expect(result.diff).toContain('ALPHA_MODIFIED')
  })

  it('值为 undefined 的键等同于没传（进程内注入时它们原样到达，走 HTTP 时会被丢掉）', async () => {
    // core 的 toTauriInput 是整份对象字面量返回，可选项无值时键存在且为 undefined。
    // 用 `'key' in args` 判存在会让同一份入参在两种传输下走不同分支。
    const result = (await gitHandler()({
      workspace_root: workspace.root,
      paths: undefined,
      staged: undefined,
      base: undefined,
      max_diff_chars: undefined,
      include_stat: undefined,
    })) as Record<string, unknown>

    expect(result.exit_code).toBe(0)
    expect(result.base).toBeNull()
  })

  it('null 与缺席同义（serde 的 Option 就是这么收的）', async () => {
    const result = (await gitHandler()({ workspace_root: workspace.root, base: null })) as Record<
      string,
      unknown
    >

    expect(result.exit_code).toBe(0)
    expect(result.base).toBeNull()
  })

  it.each([
    ['paths', { paths: 'a.txt' }, /paths 必须是字符串数组/],
    ['paths 元素', { paths: [1] }, /paths 必须是字符串数组/],
    ['staged', { staged: 'yes' }, /staged 必须是布尔值/],
    ['base', { base: 7 }, /base 必须是字符串/],
    ['max_diff_chars 负数', { max_diff_chars: -1 }, /max_diff_chars 必须是非负整数/],
    ['max_diff_chars 小数', { max_diff_chars: 1.5 }, /max_diff_chars 必须是非负整数/],
    ['workspace_root', { workspace_root: 3 }, /workspace_root 必须是字符串/],
  ])('形状不对的 %s 在进 git 之前就被拒', async (_label, args, message) => {
    // 桌面端这一层是 Tauri 的反序列化白干的；这条路上没有那一层，漏做就会让一个
    // `paths: [123]` 一路跑进 spawn 的 argv。
    await expect(gitHandler()({ workspace_root: workspace.root, ...args })).rejects.toThrow(message)
  })
})
