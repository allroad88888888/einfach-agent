import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { resolveDeleteTarget } from './targetPath'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('resolveDeleteTarget 放行的形状', () => {
  it('相对路径解析到 root 下的绝对路径', async () => {
    await writeFile(join(workspace.root, 'note.txt'), 'x')
    await expect(resolveDeleteTarget(workspace.root, 'note.txt')).resolves.toBe(
      join(workspace.root, 'note.txt'),
    )
  })

  it('根内的绝对路径原样接受', async () => {
    await mkdir(join(workspace.root, 'build'))
    const absolute = join(workspace.root, 'build')
    await expect(resolveDeleteTarget(workspace.root, absolute)).resolves.toBe(absolute)
  })

  it('`.`、重复分隔符与结尾分隔符都被规整掉', async () => {
    await mkdir(join(workspace.root, 'build'))
    await writeFile(join(workspace.root, 'build/a.txt'), 'a')
    const expected = join(workspace.root, 'build/a.txt')
    await expect(resolveDeleteTarget(workspace.root, './build/./a.txt')).resolves.toBe(expected)
    await expect(resolveDeleteTarget(workspace.root, 'build//a.txt')).resolves.toBe(expected)
    await expect(resolveDeleteTarget(workspace.root, ' build/a.txt ')).resolves.toBe(expected)
    await expect(resolveDeleteTarget(workspace.root, 'build/')).resolves.toBe(
      join(workspace.root, 'build'),
    )
  })
})

describe('resolveDeleteTarget 的拒绝（文案跟随 Rust 原文）', () => {
  it('空串与全空白', async () => {
    await expect(resolveDeleteTarget(workspace.root, '')).rejects.toThrow(
      'path (non-empty string) is required',
    )
    await expect(resolveDeleteTarget(workspace.root, '   ')).rejects.toThrow(
      'path (non-empty string) is required',
    )
  })

  it('NUL 字节', async () => {
    await expect(resolveDeleteTarget(workspace.root, 'a\0b')).rejects.toThrow(
      'path cannot contain NUL bytes',
    )
  })

  it('`..` 分量——即使它最终指回根内也拒（词法层直接拒，不先消再判）', async () => {
    await mkdir(join(workspace.root, 'build'))
    await writeFile(join(workspace.root, 'note.txt'), 'x')
    await expect(resolveDeleteTarget(workspace.root, 'build/../note.txt')).rejects.toThrow(
      'path must not contain `..` components',
    )
    await expect(resolveDeleteTarget(workspace.root, '../secret.txt')).rejects.toThrow(
      'path must not contain `..` components',
    )
  })

  it('根外的绝对路径', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'secret')
    await expect(
      resolveDeleteTarget(workspace.root, join(workspace.base, 'secret.txt')),
    ).rejects.toThrow('path must stay within the workspace root')
  })

  it('root 自己——`.`、绝对形态、带结尾分隔符三种写法都拒', async () => {
    for (const requested of ['.', workspace.root, `${workspace.root}/`]) {
      await expect(resolveDeleteTarget(workspace.root, requested)).rejects.toThrow(
        'refusing to delete the workspace root',
      )
    }
  })

  it('目标不存在——逐段 lstat 在最后一段就失败，所以这里不是「path does not exist」', async () => {
    await expect(resolveDeleteTarget(workspace.root, 'missing.txt')).rejects.toThrow(
      'failed to resolve target path',
    )
  })

  it('路径中间那一段是软链', async () => {
    await mkdir(join(workspace.root, 'real'))
    await writeFile(join(workspace.root, 'real/note.txt'), 'keep')
    await symlink(join(workspace.root, 'real'), join(workspace.root, 'linked'))

    // 逐段检查，所以报的是**那一段**的绝对路径，不是整个请求路径。
    await expect(resolveDeleteTarget(workspace.root, 'linked/note.txt')).rejects.toThrow(
      `symbolic links are not supported by recoverable delete: \`${join(workspace.root, 'linked')}\``,
    )
  })

  it('目标本身就是软链——指向根内还是根外都一样拒', async () => {
    await writeFile(join(workspace.root, 'real.txt'), 'keep')
    await writeFile(join(workspace.base, 'outside.txt'), 'outside')
    await symlink(join(workspace.root, 'real.txt'), join(workspace.root, 'inside-link'))
    await symlink(join(workspace.base, 'outside.txt'), join(workspace.root, 'outside-link'))

    for (const name of ['inside-link', 'outside-link']) {
      await expect(resolveDeleteTarget(workspace.root, name)).rejects.toThrow(
        `symbolic links are not supported by recoverable delete: \`${join(workspace.root, name)}\``,
      )
    }
  })
})
