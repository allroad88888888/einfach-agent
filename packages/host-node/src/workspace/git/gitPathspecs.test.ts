import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizePathspecs } from './gitPathspecs'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

const NUL = String.fromCharCode(0)

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await mkdir(join(workspace.root, 'src'), { recursive: true })
  await writeFile(join(workspace.root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(workspace.base, 'secret.txt'), 'OUTSIDE\n')
})

afterEach(async () => {
  await workspace.cleanup()
})

const normalize = (paths: string[]) => normalizePathspecs(paths, workspace.root)

describe('放行的形态', () => {
  it('不传 paths 就是全仓（空清单）', async () => {
    await expect(normalizePathspecs(undefined, workspace.root)).resolves.toEqual([])
  })

  it('相对路径原样收窄成根相对 pathspec', async () => {
    await expect(normalize(['src/a.ts'])).resolves.toEqual(['src/a.ts'])
  })

  it('`./` 与重复分隔符被消掉', async () => {
    await expect(normalize(['./src//a.ts'])).resolves.toEqual(['src/a.ts'])
  })

  it('workspace 内的绝对路径转成相对', async () => {
    await expect(normalize([join(workspace.root, 'src', 'a.ts')])).resolves.toEqual(['src/a.ts'])
  })

  it('目标不存在也放行——被删除的文件正是 diff 最常见的入参', async () => {
    // 只要有一个仍在根内的已存在祖先就够；要求目标存在会让「看看我删了什么」直接报错。
    await expect(normalize(['src/gone.ts'])).resolves.toEqual(['src/gone.ts'])
  })

  it('以 `-` 开头的文件名不是选项注入（pathspec 恒在 `--` 之后）', async () => {
    await expect(normalize(['-weird.txt'])).resolves.toEqual(['-weird.txt'])
  })
})

describe('confinement', () => {
  it('相对路径里的 `..` 直接拒（目标可能不存在，词法是唯一防线）', async () => {
    await expect(normalize(['../secret.txt'])).rejects.toThrow(/must stay inside workspace root/)
  })

  it('根外的绝对路径拒', async () => {
    await expect(normalize([join(workspace.base, 'secret.txt')])).rejects.toThrow(
      /escapes workspace root/,
    )
  })

  it('前缀陷阱：`<root>-evil` 不算在 `<root>` 里', async () => {
    // 逐字符 startsWith 会把它判成根内；判定必须在分隔符边界上做。
    const sibling = `${workspace.root}-evil`
    await mkdir(sibling, { recursive: true })
    await expect(normalize([join(sibling, 'x.txt')])).rejects.toThrow(/escapes workspace root/)
  })

  it('symlink 逃逸：根内软链指向根外时拒', async () => {
    // 这条是 realpath 那一步存在的全部理由——词法上 `<root>/link/secret.txt` 稳稳在根内。
    await symlink(workspace.base, join(workspace.root, 'link'))
    await expect(normalize(['link/secret.txt'])).rejects.toThrow(/escapes workspace root/)
  })

  it('消不动的绝对路径（越过文件系统根）明确失败', async () => {
    await expect(normalize(['/../../etc/passwd'])).rejects.toThrow(/cannot be normalized/)
  })

  it('空 / 全空白路径拒', async () => {
    await expect(normalize([''])).rejects.toThrow('git diff path cannot be empty')
    await expect(normalize(['   '])).rejects.toThrow('git diff path cannot be empty')
  })

  it('含 NUL 的路径拒', async () => {
    await expect(normalize([`src${NUL}/a.ts`])).rejects.toThrow(/contains a NUL byte/)
  })

  it('解析到 workspace root 本身的路径拒（空 pathspec 等于全仓，与调用方意图相反）', async () => {
    await expect(normalize(['.'])).rejects.toThrow(/cannot resolve to the workspace root/)
    await expect(normalize([workspace.root])).rejects.toThrow(/cannot resolve to the workspace root/)
  })

  it('一批里有一条越界，整批就失败（不静默丢掉那一条）', async () => {
    await expect(normalize(['src/a.ts', '../secret.txt'])).rejects.toThrow(/must stay inside/)
  })
})
