import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { symlinkExists } from '../change/pathProbe'
import { createTempWorkspace } from './tempWorkspace.testHarness'
import { pathExists } from './pathExists'

describe('pathExists', () => {
  it('存在的文件为 true，缺失路径与悬空软链为 false', async () => {
    const workspace = await createTempWorkspace()
    try {
      const file = join(workspace.root, 'file.txt')
      const missing = join(workspace.root, 'missing.txt')
      const dangling = join(workspace.root, 'dangling')
      await writeFile(file, 'content')
      await symlink(missing, dangling)

      await expect(pathExists(file)).resolves.toBe(true)
      await expect(pathExists(missing)).resolves.toBe(false)
      await expect(pathExists(dangling)).resolves.toBe(false)
      await expect(symlinkExists(dangling)).resolves.toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })
})
