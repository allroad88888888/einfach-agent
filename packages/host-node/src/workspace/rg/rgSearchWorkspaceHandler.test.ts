// 端到端用例：真实 spawn rg，验证 handler 的编排（收窄 → spawn → 解析 → 拼结果）。
// rg 不是所有机器都装了——先探测，探测不到就整块 skip 并在用例名里说明，而不是让 CI 因为
// 环境缺依赖而失败。
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRgRoutes } from './index'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { RgSearchResult } from './types'

const rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore' }).error === undefined
const describeIfRg = rgAvailable ? describe : describe.skip

let workspace: TempWorkspace

async function handler(args: Record<string, unknown>): Promise<RgSearchResult> {
  const table = createRgRoutes({})
  const fn = table.rg_search_workspace
  if (!fn) throw new Error('workspace/rg 域必须提供 rg_search_workspace')
  return (await fn(args)) as RgSearchResult
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.base, 'secret.txt'), 'outside the workspace')
  await mkdir(join(workspace.root, 'src'))
  await writeFile(
    join(workspace.root, 'src', 'a.ts'),
    'const foo = 1\nconst bar = 2\nexport { foo, bar }\n',
  )
  await writeFile(join(workspace.root, 'src', 'b.test.ts'), "test('foo', () => { return foo })\n")
  await writeFile(join(workspace.root, 'README.md'), '# Demo\nfoo bar\n')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('rg_search_workspace：不依赖真实 rg 也能验证的入参与失败路径', () => {
  it('query 为空 → ok:false，不 reject（对齐 Rust 的 failed_result 软失败）', async () => {
    await expect(handler({ query: '   ', workspace_root: workspace.root })).resolves.toEqual({
      ok: false,
      matches: [],
      truncated: false,
      exitCode: 1,
      stderr: 'query must be a non-empty string',
    })
  })

  it('path 越界且未放行 → ok:false，stderr 提示 escapes workspace root', async () => {
    const result = await handler({
      query: 'foo',
      path: '../secret.txt',
      workspace_root: workspace.root,
    })
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/escapes workspace root/)
  })

  it('globs 含 `..` → ok:false，不崩溃', async () => {
    const result = await handler({
      query: 'foo',
      globs: ['../evil/**'],
      workspace_root: workspace.root,
    })
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/must not contain `\.\.` components/)
  })

  it('rg 不在 PATH 上：ok:false + 可读错误（一眼知道该装什么），不是崩溃/裸 ENOENT', async () => {
    const savedPath = process.env.PATH
    const emptyBinDir = await mkdtemp(join(tmpdir(), 'host-node-rg-no-path-'))
    process.env.PATH = emptyBinDir
    try {
      const result = await handler({ query: 'foo', workspace_root: workspace.root })
      expect(result.ok).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toMatch(/failed to spawn `rg`/)
      expect(result.stderr).toMatch(/ripgrep/)
    } finally {
      process.env.PATH = savedPath
      await rm(emptyBinDir, { recursive: true, force: true })
    }
  })
})

describeIfRg('rg_search_workspace：真实 rg 集成用例（探测到本机装了 ripgrep 才跑）', () => {
  it('默认大小写敏感的字面量搜索，命中跨多个文件', async () => {
    const result = await handler({ query: 'foo', workspace_root: workspace.root })
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(false)
    // 不传 path → 目标是 "."，rg 对显式给的 "." 会用 "./" 前缀回显路径（真实 rg 行为，
    // 用 bash 里手测过；Rust 的 normalize_display_path 同样只处理绝对路径，不剥这个前缀，
    // 所以两个宿主在这一点上是一致的「有点丑但对齐」，不是本次实现的 bug）。
    const paths = new Set(result.matches.map((m) => m.path))
    expect(paths).toEqual(new Set(['./src/a.ts', './src/b.test.ts', './README.md']))
  })

  it('大小写不敏感：case_sensitive:false 能匹配到大写变体', async () => {
    const result = await handler({
      query: 'FOO',
      case_sensitive: false,
      path: 'src/a.ts',
      workspace_root: workspace.root,
    })
    expect(result.ok).toBe(true)
    expect(result.matches.length).toBeGreaterThan(0)
  })

  it('默认大小写敏感时，大写 query 在只含小写的文件里找不到（exitCode 1 仍算 ok）', async () => {
    const result = await handler({ query: 'FOO', path: 'src/a.ts', workspace_root: workspace.root })
    expect(result.ok).toBe(true)
    expect(result.matches).toEqual([])
    expect(result.exitCode).toBe(1)
  })

  it('regex:false 时按字面量搜索，正则元字符不生效', async () => {
    const result = await handler({
      query: 'fo{2}',
      regex: false,
      path: 'src/a.ts',
      workspace_root: workspace.root,
    })
    expect(result.matches).toEqual([])
  })

  it('regex:true 时按正则搜索，同一模式能命中', async () => {
    const result = await handler({
      query: 'fo{2}',
      regex: true,
      path: 'src/a.ts',
      workspace_root: workspace.root,
    })
    expect(result.matches.length).toBeGreaterThan(0)
  })

  it('globs 限定扩展名：*.ts 排除 README.md', async () => {
    const result = await handler({ query: 'foo', globs: ['*.ts'], workspace_root: workspace.root })
    // 不传 path，目标同样是 "."，路径带 "./" 前缀（见上一条用例的说明）。
    const paths = new Set(result.matches.map((m) => m.path))
    expect(paths.has('./README.md')).toBe(false)
    expect(paths.has('./src/a.ts')).toBe(true)
  })

  it('path 限定子目录：只搜 src 下的文件', async () => {
    const result = await handler({ query: 'foo', path: 'src', workspace_root: workspace.root })
    const paths = new Set(result.matches.map((m) => m.path))
    expect(paths.has('README.md')).toBe(false)
  })

  it('context_lines：命中行前后各带 N 行上下文', async () => {
    // 查询词特意只命中第 2 行（`= 2`），避免第 3 行的 "bar" 也被判成命中——那样它会被
    // 归类成 match 事件而不是 context 事件，进不了本条命中的 after（这也是 parseRgStdout
    // 的既有行为：见 parseRgStdout.test.ts「两个连续命中之间」那条用例）。
    const result = await handler({
      query: '= 2',
      path: 'src/a.ts',
      context_lines: 1,
      workspace_root: workspace.root,
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.before).toEqual(['const foo = 1'])
    expect(result.matches[0]?.after).toEqual(['export { foo, bar }'])
  })

  it('max_matches：命中数到上限就截断，truncated:true', async () => {
    const result = await handler({ query: 'foo', max_matches: 1, workspace_root: workspace.root })
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('列号是 1-based：命中在行首时列号为 1', async () => {
    const result = await handler({ query: 'const', path: 'src/a.ts', workspace_root: workspace.root })
    expect(result.matches[0]?.column).toBe(1)
  })
})
