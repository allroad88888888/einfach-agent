import { execFile } from 'node:child_process'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWorkspaceRoot } from './resolveWorkspaceRoot'
import { createTempWorkspace, type TempWorkspace } from './tempWorkspace.testHarness'

const execFileAsync = promisify(execFile)

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

/** 在临时基座里现开一个 git 仓库，返回它的根与一个深层子目录。 */
async function createTempRepository(base: string): Promise<{ root: string; nested: string }> {
  const root = join(base, 'repo')
  const nested = join(root, 'nested', 'deep')
  await mkdir(nested, { recursive: true })
  await execFileAsync('git', ['init', '--quiet'], { cwd: root })
  return { root: await realpath(root), nested }
}

describe('resolveWorkspaceRoot', () => {
  it('显式传入的 root 会被 canonicalize（软链解成真实目录）', async () => {
    const link = join(workspace.base, 'link-to-workspace')
    await symlink(workspace.root, link)

    await expect(resolveWorkspaceRoot(link)).resolves.toBe(workspace.root)
  })

  it('不传 root 时从 cwd 往上派生 git 仓库根', async () => {
    // 兜底那条路本身也要有测试：桌面端 P1 修复的全部意义就是「不许回退到裸 cwd」，而回退与
    // 派生在返回值上很像——只有从**子目录**出发才分得开：回退给的是子目录，派生给的是仓库根。
    const repository = await createTempRepository(workspace.base)

    await expect(resolveWorkspaceRoot(undefined, { cwd: repository.nested })).resolves.toBe(
      repository.root,
    )
  })

  it('空白字符串等同于没传，同样走 git 派生', async () => {
    const repository = await createTempRepository(workspace.base)

    await expect(resolveWorkspaceRoot('   ', { cwd: repository.nested })).resolves.toBe(
      repository.root,
    )
  })

  it('cwd 不在 git 仓库里时拒绝服务，绝不回退到裸 cwd', async () => {
    await expect(resolveWorkspaceRoot(undefined, { cwd: workspace.root })).rejects.toThrow(
      /not inside a git repository/,
    )
  })

  it('拒绝文件系统根', async () => {
    // 否则整块磁盘都成了 workspace，confine 形同虚设。
    await expect(resolveWorkspaceRoot('/')).rejects.toThrow(/filesystem root/)
  })

  it('解析不了的显式 root 明确失败', async () => {
    await expect(resolveWorkspaceRoot(join(workspace.root, 'no-such-dir'))).rejects.toThrow(
      /failed to resolve workspace root/,
    )
  })

  it('workspace root 本身可以是软链（被链接的 skill 目录当独立根来读）', async () => {
    const target = join(workspace.base, 'outside-skill')
    await mkdir(target)
    const link = join(workspace.root, 'linked')
    await symlink(target, link)

    // 与桌面端 linked_skill_dir_can_be_listed_as_its_own_root 同一条契约：软链根解成目标目录，
    // 之后目录内的文件就都在「自己的根」里，不需要 allowExternalPaths。
    await expect(resolveWorkspaceRoot(link)).resolves.toBe(await realpath(target))
  })
})
