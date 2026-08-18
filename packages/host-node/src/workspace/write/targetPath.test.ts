import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWriteTarget } from './targetPath'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
  await mkdir(join(workspace.base, 'outside'))
  await writeFile(join(workspace.root, 'inside.txt'), 'ok')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('resolveWriteTarget（目标可能尚不存在）', () => {
  it('已存在的根内文件：绝对路径 canonicalize，展示路径根相对', async () => {
    await expect(resolveWriteTarget(workspace.root, 'inside.txt')).resolves.toEqual({
      absolutePath: join(workspace.root, 'inside.txt'),
      displayPath: 'inside.txt',
    })
  })

  it('尚不存在的多级目标：最近已存在祖先是 root，缺失段原样接回', async () => {
    // 对齐 Rust 的 resolve_existing_ancestor：`a/` `b/` 都不存在，照样解析成功——
    // 建目录是流水线按 createDirs 决定的事，不是路径解析该拒的。
    await expect(resolveWriteTarget(workspace.root, 'a/b/c.txt')).resolves.toEqual({
      absolutePath: join(workspace.root, 'a', 'b', 'c.txt'),
      displayPath: 'a/b/c.txt',
    })
  })

  it('`./` 分量被吃掉，展示路径不带它', async () => {
    await expect(resolveWriteTarget(workspace.root, './a/./b.txt')).resolves.toEqual({
      absolutePath: join(workspace.root, 'a', 'b.txt'),
      displayPath: 'a/b.txt',
    })
  })

  it('根内绝对路径被接受', async () => {
    await expect(resolveWriteTarget(workspace.root, join(workspace.root, 'new.txt'))).resolves.toEqual(
      {
        absolutePath: join(workspace.root, 'new.txt'),
        displayPath: 'new.txt',
      },
    )
  })

  it('目标就是 root 本身：展示路径是 `.`', async () => {
    await expect(resolveWriteTarget(workspace.root, '.')).resolves.toEqual({
      absolutePath: workspace.root,
      displayPath: '.',
    })
  })

  it('① 词法逃逸：`../evil.txt` 被当场拒（不等 realpath）', async () => {
    // 对齐 Rust 测试 rejects_parent_escape：写入侧对 `..` 是直接拒，错误里必须出现 `..`。
    await expect(resolveWriteTarget(workspace.root, '../evil.txt')).rejects.toThrow(
      /must not contain `\.\.` components/,
    )
  })

  it('① 词法逃逸：目标不存在时同样在词法层被拒', async () => {
    await expect(resolveWriteTarget(workspace.root, 'a/../../evil.txt')).rejects.toThrow(/\.\./)
  })

  it('② 绝对路径逃逸：根外绝对路径被拒', async () => {
    // 对齐 Rust 测试 rejects_absolute_outside_path。
    await expect(
      resolveWriteTarget(workspace.root, join(workspace.base, 'evil.txt')),
    ).rejects.toThrow(/must stay within the workspace root/)
  })

  it('② 前缀陷阱：`<root>-evil/x.txt` 不算根内', async () => {
    // 直译 starts_with 会放行这个路径，而它是磁盘上另一个目录。判定必须在分隔符边界上比。
    await expect(resolveWriteTarget(workspace.root, `${workspace.root}-evil/x.txt`)).rejects.toThrow(
      /must stay within the workspace root/,
    )
  })

  it('③ symlink 逃逸：覆盖一个指向根外文件的软链被拒', async () => {
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'alias.txt'))
    await expect(resolveWriteTarget(workspace.root, 'alias.txt')).rejects.toThrow(
      /must stay within the workspace root/,
    )
  })

  it('③ symlink 逃逸：往指向根外目录的软链里新建文件被拒', async () => {
    // 目标 `link/new.txt` 还不存在，词法上稳稳在 root 下——只有最近已存在祖先（`link`）被
    // canonicalize 之后才看得出它其实在 base 里。这条就是「祖先要解真实路径」的全部理由。
    await symlink(join(workspace.base, 'outside'), join(workspace.root, 'link'))
    await expect(resolveWriteTarget(workspace.root, 'link/new.txt')).rejects.toThrow(
      /must stay within the workspace root/,
    )
  })

  it('空路径与纯空白都被拒（写入侧自己 trim）', async () => {
    await expect(resolveWriteTarget(workspace.root, '')).rejects.toThrow(
      /path \(non-empty string\) is required/,
    )
    await expect(resolveWriteTarget(workspace.root, '   ')).rejects.toThrow(
      /path \(non-empty string\) is required/,
    )
  })

  it('含 NUL 的路径被拒', async () => {
    await expect(resolveWriteTarget(workspace.root, 'a\0b.txt')).rejects.toThrow(
      /cannot contain NUL bytes/,
    )
  })

  it('非字符串按「没给路径」处理，不抛 TypeError', async () => {
    // handler 拿到的是未经校验的 Record<string, unknown>：`args.path` 缺失时是 undefined，
    // 直接 .trim() 会抛 TypeError 而不是给出可读失败。
    await expect(resolveWriteTarget(workspace.root, undefined)).rejects.toThrow(
      /path \(non-empty string\) is required/,
    )
    await expect(resolveWriteTarget(workspace.root, 42)).rejects.toThrow(
      /path \(non-empty string\) is required/,
    )
  })
})
