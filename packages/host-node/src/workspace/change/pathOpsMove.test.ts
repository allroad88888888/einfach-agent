import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { movePath } from './pathOpsMove'
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

describe('movePath', () => {
  it('搬走文件：目标出现、源消失，缺失的父目录顺手建出来', async () => {
    await writeFile(at('a.txt'), 'a')

    await movePath(at('a.txt'), at('nested', 'b.txt'))

    await expect(readFile(at('nested', 'b.txt'), 'utf8')).resolves.toBe('a')
    await expect(readdir(workspace.root)).resolves.toEqual(['nested'])
  })

  it('搬走整棵目录树', async () => {
    await mkdir(at('tree', 'inner'), { recursive: true })
    await writeFile(at('tree', 'inner', 'deep.txt'), 'deep')

    await movePath(at('tree'), at('moved'))

    await expect(readFile(at('moved', 'inner', 'deep.txt'), 'utf8')).resolves.toBe('deep')
    await expect(readdir(workspace.root)).resolves.toEqual(['moved'])
  })

  it('删源失败时把复制出来的目标删掉——同一份内容不能在两个地方各留一份', async () => {
    // rename 在同一文件系统内不会失败，所以先造出「必须走复制流程」的形态：目标已存在。
    // 目标存在时 rename 会直接覆盖，于是这里换一种造法——把源放进只读目录，让删源失败。
    const guarded = at('guarded')
    await mkdir(guarded)
    await writeFile(join(guarded, 'a.txt'), 'a')
    await chmod(guarded, 0o500)

    try {
      // rename 需要源目录的写权限，因此这一步会失败并退成「复制 + 删源」，删源同样失败。
      await expect(movePath(join(guarded, 'a.txt'), at('moved.txt'))).rejects.toThrow(
        'failed to remove copied source',
      )
      await expect(readdir(workspace.root)).resolves.toEqual(['guarded'])
      await expect(readFile(join(guarded, 'a.txt'), 'utf8')).resolves.toBe('a')
    } finally {
      await chmod(guarded, 0o700)
    }
  })

  it('源不存在时抛，不静默建一个空目标', async () => {
    await expect(movePath(at('missing'), at('moved'))).rejects.toThrow('failed to inspect')
    await expect(readdir(workspace.root)).resolves.toEqual([])
  })
})
