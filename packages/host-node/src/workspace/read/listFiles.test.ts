// `list_workspace_files` 的端到端用例，对齐 apps/desktop/src/workspace_read_list_tests.rs，并补上
// Rust 侧没有显式钉住、但两个宿主必须同款的边角：symlink 列出但不进去（含断链/越界两种「整条
// 不列」的情形）、maxEntries 命中即整体停止（不是「这次不多列了」）、includeHidden 对递归的影响、
// 排序按文件名小写。一律经 `createListWorkspaceFilesHandler`（registrar 要挂的那个工厂）调用。
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createListWorkspaceFilesHandler } from './listFiles'
import type { ListWorkspaceFilesResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function list(args: Record<string, unknown>): Promise<ListWorkspaceFilesResult> {
  return createListWorkspaceFilesHandler({})({
    workspace_root: workspace.root,
    ...args,
  }) as Promise<ListWorkspaceFilesResult>
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

describe('list_workspace_files：基础列举', () => {
  it('非递归只列直接子项，按文件名小写排序，文件带 size、目录不带', async () => {
    await mkdir(join(workspace.root, 'src'))
    await seedFile('Banana.txt', 'abc')
    await seedFile('apple.txt', 'de')
    await seedFile('src/nested.ts', 'x') // 不应出现：非递归

    const result = await list({ path: '.' })
    expect(result.truncated).toBe(false)
    expect(result.entries).toEqual([
      { path: 'apple.txt', type: 'file', size: 2 },
      { path: 'Banana.txt', type: 'file', size: 3 },
      { path: 'src', type: 'directory' },
    ])
  })

  it('递归列出嵌套文件（对齐 Rust list_files_includes_nested_entry）', async () => {
    await mkdir(join(workspace.root, 'src'))
    await seedFile('src/app.ts', 'export const x = 1;\n')

    const result = await list({ path: '.', recursive: true })
    expect(result.entries).toContainEqual({ path: 'src/app.ts', type: 'file', size: 20 })
  })

  it('path 不传时默认列 "."', async () => {
    await seedFile('root.txt')
    const result = await list({})
    expect(result.entries).toContainEqual({ path: 'root.txt', type: 'file', size: 0 })
  })
})

describe('list_workspace_files：错误路径', () => {
  it('目录不存在报 not accessible（对齐 Rust list_missing_directory_errors_with_not_accessible_text）', async () => {
    await expect(list({ path: '.webAgent/skills' })).rejects.toThrow(/is not accessible/i)
  })

  it('目标是文件而不是目录时拒绝', async () => {
    await seedFile('notes.txt')
    await expect(list({ path: 'notes.txt' })).rejects.toThrow(/is not a directory/)
  })
})

describe('list_workspace_files：includeHidden', () => {
  it('默认不列隐藏文件/目录，且隐藏目录里的非隐藏文件也不可见（对齐 Rust 的 skills 用例语境）', async () => {
    await mkdir(join(workspace.root, '.webAgent/skills/demo'), { recursive: true })
    await seedFile('.webAgent/skills/demo/SKILL.md', '---\nname: demo\n---\n')
    await seedFile('visible.txt')

    const result = await list({ path: '.', recursive: true })
    const paths = result.entries.map((entry) => entry.path)
    expect(paths).toEqual(['visible.txt'])
  })

  it('includeHidden: true 时隐藏目录被列出并递归进去，路径是 workspace 相对正斜杠', async () => {
    await mkdir(join(workspace.root, '.webAgent/skills/demo/references'), { recursive: true })
    await seedFile('.webAgent/skills/demo/SKILL.md', '---\nname: demo\n---\n')
    await seedFile('.webAgent/skills/demo/references/checklist.md', 'x')

    const result = await list({ path: '.webAgent/skills', recursive: true, include_hidden: true })
    const paths = result.entries.map((entry) => entry.path)
    expect(paths).toContain('.webAgent/skills/demo/SKILL.md')
    expect(paths).toContain('.webAgent/skills/demo/references/checklist.md')
    expect('.webAgent/skills/demo/SKILL.md'.split('/')).toHaveLength(4)
  })
})

describe('list_workspace_files：maxEntries 截断', () => {
  it('命中上限即整体停止遍历，不是「这次不多列了」', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedFile(`file-${index}.txt`)
    }

    const result = await list({ path: '.', max_entries: 2 })
    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(2)
    // 按排序应恰好是最前两个（file-0、file-1），证明是硬停不是随机丢弃。
    expect(result.entries.map((entry) => entry.path)).toEqual(['file-0.txt', 'file-1.txt'])
  })

  it('隐藏/越界被跳过的条目不计入 maxEntries、也不触发 truncated', async () => {
    await seedFile('.hidden.txt')
    await seedFile('a.txt')
    await seedFile('b.txt')

    const result = await list({ path: '.', max_entries: 2 })
    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt'])
  })
})

describe('list_workspace_files：symlink 列出但不进去', () => {
  it('指向根内目录的 symlink 被列为 symlink 类型，recursive 时不会递归进它', async () => {
    await mkdir(join(workspace.root, 'real'))
    await seedFile('real/inside.txt')
    await symlink(join(workspace.root, 'real'), join(workspace.root, 'link-to-real'), 'dir')

    const result = await list({ path: '.', recursive: true })
    const linkEntry = result.entries.find((entry) => entry.path === 'link-to-real')
    expect(linkEntry).toEqual({ path: 'link-to-real', type: 'symlink' })
    expect(result.entries.some((entry) => entry.path === 'link-to-real/inside.txt')).toBe(false)
    // 但通过真实路径本身仍能看到内容。
    expect(result.entries.some((entry) => entry.path === 'real/inside.txt')).toBe(true)
  })

  it('断链（目标不存在）整条不列，不只是不递归', async () => {
    await symlink(join(workspace.root, 'does-not-exist'), join(workspace.root, 'dangling'), 'file')

    const result = await list({ path: '.' })
    expect(result.entries.some((entry) => entry.path === 'dangling')).toBe(false)
  })

  it('指向 workspace 外的 symlink 在未开 allowExternalPaths 时整条不列', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'nope')
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'escape'), 'file')

    const result = await list({ path: '.' })
    expect(result.entries.some((entry) => entry.path === 'escape')).toBe(false)
  })

  it('allowExternalPaths: true 时越界 symlink 被列出（仍是 symlink 类型，仍不递归）', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'nope')
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'escape'), 'file')

    const result = await list({ path: '.', allow_external_paths: true })
    expect(result.entries.find((entry) => entry.path === 'escape')).toEqual({
      path: 'escape',
      type: 'symlink',
    })
  })
})
