import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { normalizeRgTargetPath } from './normalizeRgTargetPath'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
  await mkdir(join(workspace.root, 'src'))
  await writeFile(join(workspace.root, 'src', 'a.ts'), 'x')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('normalizeRgTargetPath', () => {
  it('未传 / trim 后为空 → "."，不碰文件系统', async () => {
    await expect(normalizeRgTargetPath(workspace.root, undefined, false)).resolves.toBe('.')
    await expect(normalizeRgTargetPath(workspace.root, '   ', false)).resolves.toBe('.')
  })

  it('root 自身 → "."', async () => {
    await expect(normalizeRgTargetPath(workspace.root, '.', false)).resolves.toBe('.')
  })

  it('root 内的子路径 → 斜杠拼接的根相对路径', async () => {
    await expect(normalizeRgTargetPath(workspace.root, 'src', false)).resolves.toBe('src')
    await expect(normalizeRgTargetPath(workspace.root, 'src/a.ts', false)).resolves.toBe('src/a.ts')
  })

  it('越界且不允许 external → 拒绝', async () => {
    await expect(normalizeRgTargetPath(workspace.root, '../secret.txt', false)).rejects.toThrow(
      /escapes workspace root/,
    )
  })

  it('symlink 逃逸同样被 confinement 拦住', async () => {
    await symlink(join(workspace.base, 'secret.txt'), join(workspace.root, 'linked.txt'))
    await expect(normalizeRgTargetPath(workspace.root, 'linked.txt', false)).rejects.toThrow(
      /escapes workspace root/,
    )
  })

  it('allowExternalPaths=true → 越界路径给回斜杠化的绝对路径', async () => {
    await expect(normalizeRgTargetPath(workspace.root, '../secret.txt', true)).resolves.toBe(
      join(workspace.base, 'secret.txt').split(sep).join('/'),
    )
  })

  it('不存在的目标明确失败', async () => {
    await expect(normalizeRgTargetPath(workspace.root, 'nope.txt', false)).rejects.toThrow(
      /is not accessible/,
    )
  })

  it('含 NUL 的路径被拒', async () => {
    await expect(normalizeRgTargetPath(workspace.root, 'a\0b.txt', false)).rejects.toThrow(/NUL bytes/)
  })
})
