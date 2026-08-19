import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relativeDisplay, resolveDestination, resolveSource } from './resolveTarget'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

function at(...segments: string[]): string {
  return join(workspace.root, ...segments)
}

describe('resolveSource', () => {
  it('解析已存在的相对路径，穿过软链解出真实路径', async () => {
    await writeFile(at('a.txt'), 'a')
    await expect(resolveSource(workspace.root, 'a.txt')).resolves.toBe(at('a.txt'))
  })

  it('源不存在就拒，文案里带上失败原因', async () => {
    await expect(resolveSource(workspace.root, 'missing.txt')).rejects.toThrow(
      'failed to resolve source',
    )
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['带 ..', '../secret.txt'],
    ['空串', '   '],
  ])('拒绝非法形状：%s', async (_label, raw) => {
    await expect(resolveSource(workspace.root, raw)).rejects.toThrow(
      'path must be a non-empty workspace-relative path without',
    )
  })

  it('软链指向 root 外时按越界拒绝，即便词法上不含 ..', async () => {
    const outsideFile = join(workspace.base, 'outside.txt')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, at('link.txt'))
    await expect(resolveSource(workspace.root, 'link.txt')).rejects.toThrow(
      'source escaped workspace root',
    )
  })
})

describe('resolveDestination', () => {
  it('返回未 canonicalize 的拼接路径，顺手建出缺失的父目录归属确认', async () => {
    await expect(resolveDestination(workspace.root, 'nested/new.txt')).resolves.toBe(
      at('nested', 'new.txt'),
    )
  })

  it('目标已存在就拒——不静默覆盖', async () => {
    await writeFile(at('a.txt'), 'a')
    await expect(resolveDestination(workspace.root, 'a.txt')).rejects.toThrow(
      'destination already exists',
    )
  })

  it('目标是悬空软链也算已存在（symlink_metadata 不跟随）', async () => {
    await symlink(at('missing-target'), at('dangling.txt'))
    await expect(resolveDestination(workspace.root, 'dangling.txt')).rejects.toThrow(
      'destination already exists',
    )
  })

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['带 ..', '../secret.txt'],
  ])('拒绝非法形状：%s', async (_label, raw) => {
    await expect(resolveDestination(workspace.root, raw)).rejects.toThrow(
      'path must be a non-empty workspace-relative path without',
    )
  })

  it('最近已存在的祖先经软链指向 root 外时拒绝', async () => {
    const outsideDir = join(workspace.base, 'outside')
    await mkdir(outsideDir)
    await symlink(outsideDir, at('link'))
    await expect(resolveDestination(workspace.root, 'link/new.txt')).rejects.toThrow(
      'destination escaped workspace root',
    )
  })
})

describe('relativeDisplay', () => {
  it('剥掉 root 前缀，正斜杠原样保留', () => {
    expect(relativeDisplay(workspace.root, at('nested', 'a.txt'))).toBe('nested/a.txt')
  })

  it(
    '照搬 Rust 的 relative() bug（docs/node-host-issues.md #11）：无条件替换反斜杠，' +
      'unix 上会把合法文件名 a\\b.txt 显示成 a/b.txt',
    () => {
      expect(relativeDisplay(workspace.root, at('a\\b.txt'))).toBe('a/b.txt')
    },
  )

  it('落在 root 外时原样返回整个绝对路径（同样做反斜杠替换）', () => {
    const outside = join(workspace.base, 'outside.txt')
    expect(relativeDisplay(workspace.root, outside)).toBe(outside.replace(/\\/g, '/'))
  })
})
