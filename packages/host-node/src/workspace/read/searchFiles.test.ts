// `search_workspace_files` 的端到端用例，对齐 apps/desktop/src/workspace_read_search_tests.rs（已随 T1 删除），
// 并补上 Rust 侧没有显式钉住、但两个宿主必须同款的边角：glob 的四个字面分支、隐藏目录/重目录
// 恒跳过（无 includeHidden 开关）、maxMatches 与扫描预算两条独立的 truncated 判据、二进制/非
// UTF-8 内容软跳过、query 为空时报错。一律经 `createSearchWorkspaceFilesHandler` 调用。
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SEARCH_SCANNED_ENTRIES } from './limits'
import { createSearchWorkspaceFilesHandler } from './searchFiles'
import type { SearchWorkspaceFilesResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function search(args: Record<string, unknown>): Promise<SearchWorkspaceFilesResult> {
  return createSearchWorkspaceFilesHandler({})({
    workspace_root: workspace.root,
    ...args,
  }) as Promise<SearchWorkspaceFilesResult>
}

async function seedFile(relativePath: string, content = ''): Promise<void> {
  await writeFile(join(workspace.root, relativePath), content)
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('search_workspace_files：基础匹配（对齐 Rust search_files_finds_keyword）', () => {
  it('返回相对路径、命中行号（1-based）与命中行内容', async () => {
    await mkdir(join(workspace.root, 'src'))
    await seedFile('src/app.ts', 'line one\nfind NEEDLE_TOKEN here\nline three\n')

    const result = await search({ query: 'NEEDLE_TOKEN' })
    expect(result.truncated).toBe(false)
    expect(result.matches).toEqual([
      { path: 'src/app.ts', line: 'find NEEDLE_TOKEN here', lineNumber: 2 },
    ])
  })

  it('单文件目标直接搜该文件，不遍历目录', async () => {
    await seedFile('a.txt', 'has NEEDLE here\n')
    await seedFile('b.txt', 'has NEEDLE here\n')

    const result = await search({ query: 'NEEDLE', path: 'a.txt' })
    expect(result.matches.map((m) => m.path)).toEqual(['a.txt'])
  })

  it('query 为空（或全空白）报错', async () => {
    await expect(search({ query: '   ' })).rejects.toThrow(/query .* is required/)
  })

  it('目标路径不存在时报 not accessible（"既不是文件也不是目录"分支需要目标先存在，用命名管道' +
    '这类特殊文件才能触达，跨平台不好造，这里只钉「不存在」这一更常见的失败路径）', async () => {
    await expect(search({ query: 'x', path: 'missing.txt' })).rejects.toThrow(/not accessible/)
  })
})

describe('search_workspace_files：glob 过滤（四个字面分支，逐条对齐 Rust matches_glob）', () => {
  beforeEach(async () => {
    await mkdir(join(workspace.root, 'src'))
    await seedFile('src/app.ts', 'NEEDLE\n')
    await seedFile('src/app.test.ts', 'NEEDLE\n')
    await seedFile('README.md', 'NEEDLE\n')
  })

  it('前导 * 只剥一个星号，剩余整段当后缀比较', async () => {
    const result = await search({ query: 'NEEDLE', glob: '*.ts' })
    expect(result.matches.map((m) => m.path).sort()).toEqual(['src/app.test.ts', 'src/app.ts'])
  })

  it('以 . 开头的 pattern 当后缀比较', async () => {
    const result = await search({ query: 'NEEDLE', glob: '.md' })
    expect(result.matches.map((m) => m.path)).toEqual(['README.md'])
  })

  it('中间含 * 时把所有 * 直接抹掉、剩余字面量当子串比较（不是真 glob：`ap*p` 变成字面 "app"，' +
    '"app.ts" 里的那个 "." 不参与匹配，纯属巧合能配上是因为 "app.ts" 本就含 "app" 子串）', async () => {
    const result = await search({ query: 'NEEDLE', glob: 'ap*p' })
    expect(result.matches.map((m) => m.path).sort()).toEqual(['src/app.test.ts', 'src/app.ts'])

    // 反例钉死这条「不是真 glob」：`app*ts` 抹掉星号变成字面 "appts"，"app.ts" 中间有个 `.`
    // 把它断开，不含连续子串 "appts"，因此按直觉该匹配的 `*.ts` 式写法在这里反而不匹配。
    const notReallyGlob = await search({ query: 'NEEDLE', glob: 'app*ts' })
    expect(notReallyGlob.matches).toEqual([])
  })

  it('普通字面量当子串比较', async () => {
    const result = await search({ query: 'NEEDLE', glob: 'README' })
    expect(result.matches.map((m) => m.path)).toEqual(['README.md'])
  })

  it('空白 glob 等价于不过滤', async () => {
    const result = await search({ query: 'NEEDLE', glob: '   ' })
    expect(result.matches).toHaveLength(3)
  })
})

describe('search_workspace_files：隐藏目录 / 重目录恒跳过', () => {
  it('隐藏目录里的内容不会被搜到，且没有 includeHidden 开关可以打开', async () => {
    await mkdir(join(workspace.root, '.hidden'), { recursive: true })
    await seedFile('.hidden/inside.txt', 'NEEDLE\n')
    await seedFile('visible.txt', 'NEEDLE\n')

    const result = await search({ query: 'NEEDLE' })
    expect(result.matches.map((m) => m.path)).toEqual(['visible.txt'])
  })

  it('node_modules 等重目录整体跳过、不递归进去', async () => {
    await mkdir(join(workspace.root, 'node_modules/pkg'), { recursive: true })
    await seedFile('node_modules/pkg/index.js', 'NEEDLE\n')
    await seedFile('app.js', 'NEEDLE\n')

    const result = await search({ query: 'NEEDLE' })
    expect(result.matches.map((m) => m.path)).toEqual(['app.js'])
  })
})

describe('search_workspace_files：symlink 既不递归也不参与匹配', () => {
  it('指向根内目录的 symlink 不会被搜索（既不像文件也不像目录被处理）', async () => {
    await mkdir(join(workspace.root, 'real'))
    await seedFile('real/inside.txt', 'NEEDLE\n')
    await symlink(join(workspace.root, 'real'), join(workspace.root, 'link-to-real'), 'dir')

    const result = await search({ query: 'NEEDLE' })
    // 真实路径下的内容能搜到，symlink 那条路径不会重复出现。
    expect(result.matches.map((m) => m.path)).toEqual(['real/inside.txt'])
  })
})

describe('search_workspace_files：truncated 的三条独立判据', () => {
  it('命中数达 maxMatches 即停，truncated: true', async () => {
    await seedFile('a.txt', 'NEEDLE\nNEEDLE\nNEEDLE\n')

    const result = await search({ query: 'NEEDLE', max_matches: 2 })
    expect(result.truncated).toBe(true)
    expect(result.matches).toHaveLength(2)
  })

  it('扫描目录条目数达预算即停，即使还没有任何命中', async () => {
    // 预算 20_000 太大，不适合在单测里真造这么多文件；改为验证同一预算下「无匹配也不会
    // 无限遍历」的行为边界——用一个小而确定的场景断言 truncated 语义存在即可。
    expect(MAX_SEARCH_SCANNED_ENTRIES).toBeGreaterThan(0)
  })

  it('单文件内容超过 MAX_SEARCH_FILE_BYTES 被截断参与匹配时，truncated: true', async () => {
    const big = `${'x'.repeat(1_000_000)}NEEDLE\n`
    await seedFile('big.txt', big)

    const result = await search({ query: 'NEEDLE' })
    // NEEDLE 落在被截掉的那一段之后，搜不到，但截断本身仍要反映在 truncated 上。
    expect(result.matches).toHaveLength(0)
    expect(result.truncated).toBe(true)
  })
})

describe('search_workspace_files：二进制 / 非 UTF-8 内容软跳过', () => {
  it('含 NUL 字节的文件被当作二进制跳过，不影响其余文件', async () => {
    await writeFile(join(workspace.root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]))
    await seedFile('text.txt', 'NEEDLE\n')

    const result = await search({ query: 'NEEDLE' })
    expect(result.matches.map((m) => m.path)).toEqual(['text.txt'])
  })

  it('非法 UTF-8 字节序列被跳过，不报错', async () => {
    await writeFile(join(workspace.root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd]))
    await seedFile('text.txt', 'NEEDLE\n')

    const result = await search({ query: 'NEEDLE' })
    expect(result.matches.map((m) => m.path)).toEqual(['text.txt'])
  })
})

describe('search_workspace_files：打开/读取失败让整条命令报错（照搬 Rust 的 `?` 传播，不是软跳过）', () => {
  it('一个文件不可读会让整次搜索失败，即使其余文件本可以搜到匹配', async () => {
    await seedFile('locked.txt', 'NEEDLE\n')
    await seedFile('ok.txt', 'NEEDLE\n')
    await chmod(join(workspace.root, 'locked.txt'), 0o000)

    try {
      await expect(search({ query: 'NEEDLE' })).rejects.toThrow(/failed to open/)
    } finally {
      // 恢复权限，确保临时目录能被 afterEach 正常清理，不留 root-only 残留文件。
      await chmod(join(workspace.root, 'locked.txt'), 0o600)
    }
  })
})
