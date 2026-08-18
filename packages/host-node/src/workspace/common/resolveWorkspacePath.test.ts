import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveExistingWorkspacePath,
  resolveWorkspaceTargetPath,
} from './resolveWorkspacePath'
import { createTempWorkspace, type TempWorkspace } from './tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
  await writeFile(join(workspace.root, 'inside.txt'), 'ok')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('resolveExistingWorkspacePath（必须已存在的目标）', () => {
  it('根内路径正常解析', async () => {
    await expect(resolveExistingWorkspacePath(workspace.root, 'inside.txt')).resolves.toEqual({
      absolutePath: join(workspace.root, 'inside.txt'),
      external: false,
    })
  })

  it('① 词法逃逸：`../secret.txt` 被拒', async () => {
    await expect(resolveExistingWorkspacePath(workspace.root, '../secret.txt')).rejects.toThrow(
      /escapes workspace root/,
    )
  })

  it('① 词法逃逸：多层 `../` 同样被拒', async () => {
    await expect(
      resolveExistingWorkspacePath(workspace.root, '../../../../../../etc/passwd'),
    ).rejects.toThrow(/escapes workspace root|is not accessible/)
  })

  it('② 绝对路径逃逸：根外绝对路径被拒', async () => {
    await expect(
      resolveExistingWorkspacePath(workspace.root, join(workspace.base, 'secret.txt')),
    ).rejects.toThrow(/escapes workspace root/)
  })

  it('③ symlink 逃逸：根内软链指向根外文件被拒', async () => {
    // 这条是词法检查一个字都看不出来的：`linked-secret.txt` 稳稳在 root 下，只有 realpath
    // 解开链接之后比边界才拦得住。判定必须基于解析后的真实路径，理由全在这里。
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'linked-secret.txt'))
    await expect(
      resolveExistingWorkspacePath(workspace.root, 'linked-secret.txt'),
    ).rejects.toThrow(/escapes workspace root/)
  })

  it('③ symlink 逃逸：经根内软链目录再往下走同样被拒', async () => {
    const outside = join(workspace.base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'notes.txt'), 'external')
    await symlink(outside, join(workspace.root, 'linked-dir'))
    await expect(
      resolveExistingWorkspacePath(workspace.root, 'linked-dir/notes.txt'),
    ).rejects.toThrow(/escapes workspace root/)
  })

  it('前缀陷阱：同前缀的兄弟目录不算 workspace 内', async () => {
    // `<root>-evil` 与 root 只差一个后缀，裸 startsWith 会放行。
    const sibling = `${workspace.root}-evil`
    await mkdir(sibling)
    await writeFile(join(sibling, 'secret.txt'), 'sibling secret')
    await expect(
      resolveExistingWorkspacePath(workspace.root, join(sibling, 'secret.txt')),
    ).rejects.toThrow(/escapes workspace root/)
  })

  it('指向根内的软链是允许的（解开后仍在根里）', async () => {
    await symlink(join(workspace.root, 'inside.txt'), join(workspace.root, 'linked-inside.txt'))
    await expect(
      resolveExistingWorkspacePath(workspace.root, 'linked-inside.txt'),
    ).resolves.toEqual({ absolutePath: join(workspace.root, 'inside.txt'), external: false })
  })

  it('allowExternalPaths 是 Auto 会话的特权：三类逃逸都放行，并标记 external', async () => {
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'linked-secret.txt'))
    const expected = { absolutePath: join(workspace.base, 'secret.txt'), external: true }
    const options = { allowExternalPaths: true }

    await expect(
      resolveExistingWorkspacePath(workspace.root, '../secret.txt', options),
    ).resolves.toEqual(expected)
    await expect(
      resolveExistingWorkspacePath(workspace.root, join(workspace.base, 'secret.txt'), options),
    ).resolves.toEqual(expected)
    await expect(
      resolveExistingWorkspacePath(workspace.root, 'linked-secret.txt', options),
    ).resolves.toEqual(expected)
  })

  it('不存在的目标明确失败，而不是当成「根内的新文件」', async () => {
    await expect(resolveExistingWorkspacePath(workspace.root, 'nope.txt')).rejects.toThrow(
      /is not accessible in workspace/,
    )
  })

  it('含 NUL 的路径被拒', async () => {
    await expect(resolveExistingWorkspacePath(workspace.root, 'a\0b.txt')).rejects.toThrow(
      /NUL bytes/,
    )
  })
})

describe('resolveWorkspaceTargetPath（可能尚不存在的写入目标）', () => {
  it('根内的新文件解析成绝对路径', async () => {
    await expect(resolveWorkspaceTargetPath(workspace.root, 'new.txt')).resolves.toBe(
      join(workspace.root, 'new.txt'),
    )
  })

  it('多层尚不存在的目录也能解析（缺失段按字面接回去）', async () => {
    await expect(resolveWorkspaceTargetPath(workspace.root, 'a/b/c/new.txt')).resolves.toBe(
      join(workspace.root, 'a', 'b', 'c', 'new.txt'),
    )
  })

  it('已存在的目标解析成 canonicalize 后的路径', async () => {
    await expect(resolveWorkspaceTargetPath(workspace.root, './inside.txt')).resolves.toBe(
      join(workspace.root, 'inside.txt'),
    )
  })

  it('① 词法逃逸：`..` 在词法层面直接被拒（目标不存在时 realpath 无从下手）', async () => {
    await expect(resolveWorkspaceTargetPath(workspace.root, '../evil.txt')).rejects.toThrow(
      /must not contain `\.\.` components/,
    )
    // 即便消完仍在根内，也一样拒——与 Rust 写入侧一致，词法防线不留缺口。
    await expect(resolveWorkspaceTargetPath(workspace.root, 'a/../evil.txt')).rejects.toThrow(
      /must not contain `\.\.` components/,
    )
  })

  it('② 绝对路径逃逸：根外绝对路径被拒', async () => {
    await expect(
      resolveWorkspaceTargetPath(workspace.root, join(workspace.base, 'evil.txt')),
    ).rejects.toThrow(/must stay within the workspace root/)
  })

  it('③ symlink 逃逸：写进根内软链目录里的新文件被拒', async () => {
    // 词法上 `linked-dir/new.txt` 稳稳在 root 下，且目标还不存在——只有把「最近的已存在祖先」
    // canonicalize 再比边界才看得出来。这就是那趟祖先回溯存在的理由。
    const outside = join(workspace.base, 'outside')
    await mkdir(outside)
    await symlink(outside, join(workspace.root, 'linked-dir'))
    await expect(
      resolveWorkspaceTargetPath(workspace.root, 'linked-dir/new.txt'),
    ).rejects.toThrow(/must stay within the workspace root/)
  })

  it('③ symlink 逃逸：覆盖一个指向根外的已存在软链同样被拒', async () => {
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'linked-secret.txt'))
    await expect(
      resolveWorkspaceTargetPath(workspace.root, 'linked-secret.txt'),
    ).rejects.toThrow(/must stay within the workspace root/)
  })

  it('前缀陷阱：同前缀兄弟目录里的新文件被拒', async () => {
    const sibling = `${workspace.root}-evil`
    await mkdir(sibling)
    await expect(
      resolveWorkspaceTargetPath(workspace.root, join(sibling, 'new.txt')),
    ).rejects.toThrow(/must stay within the workspace root/)
  })

  it('空路径与含 NUL 的路径被拒', async () => {
    await expect(resolveWorkspaceTargetPath(workspace.root, '   ')).rejects.toThrow(
      /non-empty string/,
    )
    await expect(resolveWorkspaceTargetPath(workspace.root, 'a\0b.txt')).rejects.toThrow(
      /NUL bytes/,
    )
  })
})
