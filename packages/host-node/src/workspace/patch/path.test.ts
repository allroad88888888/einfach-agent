import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureParentInsideRoot, patchDisplayPath, resolvePatchPath } from './path'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
  await mkdir(join(workspace.base, 'outside'))
  await writeFile(join(workspace.root, 'inside.txt'), 'ok')
  await mkdir(join(workspace.root, 'real'))
  await writeFile(join(workspace.root, 'real', 'kept.txt'), 'kept')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('resolvePatchPath', () => {
  it('已存在的根内文件 → canonicalize 后的绝对路径', async () => {
    await expect(resolvePatchPath(workspace.root, 'inside.txt')).resolves.toBe(
      join(workspace.root, 'inside.txt'),
    )
  })

  it('尚不存在的多级目标：祖先不存在也放行（建目录是落盘那步的事）', async () => {
    await expect(resolvePatchPath(workspace.root, 'a/b/c.txt')).resolves.toBe(
      join(workspace.root, 'a', 'b', 'c.txt'),
    )
  })

  it('`./` 分量被吃掉，绝对路径与不带它时逐字相同（暂存表靠这一点不把同一文件当两个）', async () => {
    await expect(resolvePatchPath(workspace.root, './a/./b.txt')).resolves.toBe(
      join(workspace.root, 'a', 'b.txt'),
    )
  })

  it('根内绝对路径被接受', async () => {
    await expect(
      resolvePatchPath(workspace.root, join(workspace.root, 'new.txt')),
    ).resolves.toBe(join(workspace.root, 'new.txt'))
  })

  it('空路径与纯空白：`path must be a non-empty string`（**不是**写入侧那句）', async () => {
    await expect(resolvePatchPath(workspace.root, '')).rejects.toThrow(
      /^path must be a non-empty string$/,
    )
    await expect(resolvePatchPath(workspace.root, '   ')).rejects.toThrow(
      /^path must be a non-empty string$/,
    )
  })

  it('① 词法逃逸：`..` 当场拒，不等 realpath', async () => {
    await expect(resolvePatchPath(workspace.root, '../evil.txt')).rejects.toThrow(
      /must not contain `\.\.` components/,
    )
    await expect(resolvePatchPath(workspace.root, 'a/../../evil.txt')).rejects.toThrow(/\.\./)
  })

  it('② 绝对路径逃逸：根外绝对路径 → `path is outside the workspace root`', async () => {
    await expect(
      resolvePatchPath(workspace.root, join(workspace.base, 'evil.txt')),
    ).rejects.toThrow(/^path is outside the workspace root$/)
  })

  it('② 前缀陷阱：`<root>-evil/x.txt` 不算根内', async () => {
    // 直译 starts_with 会放行它，而那是磁盘上另一个目录。判定必须在分隔符边界上比。
    await expect(
      resolvePatchPath(workspace.root, `${workspace.root}-evil/x.txt`),
    ).rejects.toThrow(/^path is outside the workspace root$/)
  })

  it('③ 目标自身是软链 → 一律拒，指向根内也拒（这是 patch 独有的一条）', async () => {
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'alias.txt'))
    await symlink(join(workspace.root, 'inside.txt'), join(workspace.root, 'local-alias.txt'))
    await expect(resolvePatchPath(workspace.root, 'alias.txt')).rejects.toThrow(
      /^symlink paths are not supported$/,
    )
    await expect(resolvePatchPath(workspace.root, 'local-alias.txt')).rejects.toThrow(
      /^symlink paths are not supported$/,
    )
  })

  it('③ 软链目录逃逸：往指向根外目录的软链里新建文件 → 父目录越界', async () => {
    // 目标 `link/new.txt` 还不存在，词法上稳稳在 root 下——只有把最近已存在祖先（`link`）
    // canonicalize 之后才看得出它其实在 base 里。文案是 parent 那一套。
    await symlink(join(workspace.base, 'outside'), join(workspace.root, 'link'))
    await expect(resolvePatchPath(workspace.root, 'link/new.txt')).rejects.toThrow(
      /^parent directory is outside the workspace root$/,
    )
  })

  it('根内软链目录：目标不存在时返回**词法**路径（穿过软链），存在时返回 canonical', async () => {
    // 与写入侧不同的那一条（见文件头第 4 点）：不存在的目标不会被换成祖先的真实路径。
    await symlink(join(workspace.root, 'real'), join(workspace.root, 'link'))
    await expect(resolvePatchPath(workspace.root, 'link/fresh.txt')).resolves.toBe(
      join(workspace.root, 'link', 'fresh.txt'),
    )
    await expect(resolvePatchPath(workspace.root, 'link/kept.txt')).resolves.toBe(
      join(workspace.root, 'real', 'kept.txt'),
    )
  })

  it('`.` 解析成 root 本身：路径层不拒，目录会在「读成文本」那步失败', async () => {
    // 钉住这个边角是因为 patchDisplayPath 对 root 给的是 `.` 而 Rust patch 给空串——
    // 够不着的前提就是这里能解析成功、而暂存的第一步会失败。
    await expect(resolvePatchPath(workspace.root, '.')).resolves.toBe(workspace.root)
  })
})

describe('ensureParentInsideRoot', () => {
  it('父目录在根内 → 通过', async () => {
    await expect(
      ensureParentInsideRoot(workspace.root, join(workspace.root, 'a', 'b.txt')),
    ).resolves.toBeUndefined()
  })

  it('父目录词法上就在根外 → 拒', async () => {
    await expect(
      ensureParentInsideRoot(workspace.root, join(workspace.base, 'evil.txt')),
    ).rejects.toThrow(/^parent directory is outside the workspace root$/)
  })

  it('父目录是指向根外的软链 → 拒（词法看不出来，靠 canonicalize）', async () => {
    await symlink(join(workspace.base, 'outside'), join(workspace.root, 'link'))
    await expect(
      ensureParentInsideRoot(workspace.root, join(workspace.root, 'link', 'x.txt')),
    ).rejects.toThrow(/^parent directory is outside the workspace root$/)
  })

  it('文件系统根没有父目录 → `path must have a parent directory`', async () => {
    await expect(ensureParentInsideRoot(workspace.root, '/')).rejects.toThrow(
      /^path must have a parent directory$/,
    )
  })
})

describe('patchDisplayPath', () => {
  it('根内路径 → 根相对、正斜杠', () => {
    expect(patchDisplayPath(workspace.root, join(workspace.root, 'a', 'b.txt'))).toBe('a/b.txt')
  })

  it('根外路径 → 原样绝对路径（不给 `../..` 这种相对写法）', () => {
    expect(patchDisplayPath(workspace.root, join(workspace.base, 'x.txt'))).toBe(
      join(workspace.base, 'x.txt'),
    )
  })
})
