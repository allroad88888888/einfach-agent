import { chmod, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getWorkspaceDiff } from './workspaceDiff'
import { createGitWorkspace, runSetupGit } from './gitWorkspace.testHarness'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createGitWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

const diff = (request: Parameters<typeof getWorkspaceDiff>[0] = {}) =>
  getWorkspaceDiff({ workspaceRoot: workspace.root, ...request })

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('正常路径', () => {
  it('工作树改动会出现在 diff、status 与 changed_files 里', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')

    const result = await diff()

    expect(result.exit_code).toBe(0)
    expect(result.diff).toContain('ALPHA_MODIFIED')
    expect(result.changed_files).toContain('a.txt')
    expect(result.status_short).toContain('a.txt')
    expect(result.stat).toContain('a.txt')
    expect(result.truncated).toBe(false)
    expect(result.base).toBeNull()
  })

  it('没有任何改动时是一次成功的空结果，不是失败', async () => {
    const result = await diff()

    expect(result.exit_code).toBe(0)
    expect(result.diff).toBe('')
    expect(result.changed_files).toEqual([])
    expect(result.status_short).toBe('')
    expect(result.stat).toBe('')
    expect(result.stderr).toBe('')
  })

  it('include_stat=false 时 stat 为 null（而不是空串）', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')

    await expect(diff({ includeStat: false })).resolves.toMatchObject({ stat: null })
  })

  it('paths 收窄时 status / diff / changed_files 三者一致地排除无关文件', async () => {
    // 少了 status 那一半的收窄，changed_files 会混进 b.txt——与已收窄的 diff 自相矛盾。
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')
    await writeFile(join(workspace.root, 'b.txt'), 'BETA_MODIFIED\n')

    const result = await diff({ paths: ['a.txt'] })

    expect(result.exit_code).toBe(0)
    expect(result.diff).toContain('ALPHA_MODIFIED')
    expect(result.diff).not.toContain('BETA_MODIFIED')
    expect(result.changed_files).toEqual(['a.txt'])
  })

  it('指定 base 时与那个提交比对，并另跑 --name-only 取清单', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_IN_SECOND_COMMIT\n')
    await runSetupGit(workspace.root, ['add', 'a.txt'])
    await runSetupGit(workspace.root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'second'])

    const result = await diff({ base: 'HEAD~1' })

    expect(result.exit_code).toBe(0)
    expect(result.base).toBe('HEAD~1')
    expect(result.diff).toContain('ALPHA_IN_SECOND_COMMIT')
    expect(result.changed_files).toEqual(['a.txt'])
  })

  it('staged=true 只看已暂存的改动', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_STAGED\n')
    await runSetupGit(workspace.root, ['add', 'a.txt'])
    await writeFile(join(workspace.root, 'b.txt'), 'BETA_UNSTAGED\n')

    const result = await diff({ staged: true })

    expect(result.diff).toContain('ALPHA_STAGED')
    expect(result.diff).not.toContain('BETA_UNSTAGED')
  })

  it('重命名行取箭头右边的新路径', async () => {
    await runSetupGit(workspace.root, ['mv', 'a.txt', 'renamed.txt'])

    const result = await diff()

    expect(result.changed_files).toContain('renamed.txt')
    expect(result.changed_files).not.toContain('a.txt')
  })

  it('超上限时截断，退出码仍是成功', async () => {
    await writeFile(join(workspace.root, 'a.txt'), `${'x'.repeat(50_000)}\n`)

    const result = await diff({ maxDiffChars: 200 })

    expect(result.truncated).toBe(true)
    expect([...result.diff].length).toBe(200)
    expect(result.exit_code).toBe(0)
  })
})

describe('结构化失败（不是异常）', () => {
  it('option 形态与解析不出的 base 都被拒', async () => {
    for (const base of ['--output=/tmp/x', 'missing-ref']) {
      const result = await diff({ base })
      expect(result.exit_code).toBe(1)
      expect(result.stderr).toContain('base')
      expect(result.diff).toBe('')
    }
  })

  it('越界 pathspec 被拒', async () => {
    const result = await diff({ paths: ['../outside.txt'] })

    expect(result.exit_code).toBe(1)
    expect(result.stderr).toMatch(/stay inside|escapes/)
  })

  it('解析不了的 workspace_root 被拒', async () => {
    const result = await getWorkspaceDiff({ workspaceRoot: join(workspace.base, 'no-such-dir') })

    expect(result.exit_code).toBe(1)
    expect(result.stderr).toMatch(/failed to resolve workspace root/)
  })

  it('目录不是 git 仓库时把 git 自己的退出码与 stderr 原样交回', async () => {
    const plain = await createTempWorkspace()
    try {
      const result = await getWorkspaceDiff({ workspaceRoot: plain.root })

      expect(result.exit_code).not.toBe(0)
      expect(result.stderr).toMatch(/not a git repository/)
      expect(result.status_short).toBe('')
      expect(result.diff).toBe('')
    } finally {
      await plain.cleanup()
    }
  })
})

// P1：只读 review 绝不 spawn 外部命令。config / env / 命令行三层任何一层都盖不过——
// 这条测试盯的就是「三层里少了一层」这种静默退化：少了也照样出 diff，只有恶意仓库看得出差别。
describe.runIf(process.platform !== 'win32')('外部 diff driver', () => {
  it('仓库 config 里配了 diff.external 也不会被执行', async () => {
    const marker = join(workspace.base, 'EXTERNAL_DIFF_RAN')
    const driver = join(workspace.base, 'driver.sh')
    await writeFile(driver, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(driver, 0o755)
    await runSetupGit(workspace.root, ['config', 'diff.external', driver])
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')

    const result = await diff()

    expect(await exists(marker)).toBe(false)
    // 顺带证明 diff 本身没被这道防护打瘸：内容仍是 git 自己算的那份。
    expect(result.diff).toContain('ALPHA_MODIFIED')
  })
})
