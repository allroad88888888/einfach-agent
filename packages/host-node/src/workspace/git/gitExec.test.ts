import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffArgs } from './gitArgs'
import { runGit, runGitDiffCapped } from './gitExec'
import { createGitWorkspace } from './gitWorkspace.testHarness'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createGitWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('runGit', () => {
  it('跑得通的命令回全量 stdout 与退出码', async () => {
    const result = await runGit(workspace.root, ['status', '--short'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('git 说「这里不是仓库」是**结果**不是异常', async () => {
    // 宿主环境没坏，只是这个目录不归 git 管——调用方要看到的就是 git 的退出码与 stderr。
    const plain = await createTempWorkspace()
    try {
      const result = await runGit(plain.root, ['status', '--short'])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/not a git repository/)
    } finally {
      await plain.cleanup()
    }
  })

  it('git 起不来时抛错，而不是回一个「成功但空」的结果', async () => {
    // Node 把「起不来」做成异步的 'error' 事件；漏等它的话后面那段读会等一个永不到来的 EOF。
    await expect(runGit(join(workspace.base, 'no-such-dir'), ['status'])).rejects.toThrow(
      /failed to run git/,
    )
  })

  // GIT_LITERAL_PATHSPECS=1 的行为验证：pathspec 元字符不再被当语法展开。
  // 没有这条 env 时 `:(top)a.txt` 会从仓库顶层匹配到 a.txt，聚焦 review 会混进无关文件。
  it('pathspec 一律按字面路径处理（GIT_LITERAL_PATHSPECS）', async () => {
    const literal = await runGit(workspace.root, ['ls-files', '--', ':(top)a.txt'])
    expect(literal.exitCode).toBe(0)
    expect(literal.stdout).toBe('')

    // 对照组：同一条命令换成真实文件名就有输出，证明上面那句空不是因为命令本身跑歪了。
    const plain = await runGit(workspace.root, ['ls-files', '--', 'a.txt'])
    expect(plain.stdout).toBe('a.txt\n')
  })
})

describe('runGitDiffCapped', () => {
  it('小 diff 完整读回，不算截断', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MODIFIED\n')

    const result = await runGitDiffCapped(
      workspace.root,
      diffArgs(false, undefined, false, []),
      20_000,
    )

    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('ALPHA_MODIFIED')
  })

  it('到上限即停并杀掉 git，退出码仍报成功', async () => {
    // truncated 是我们主动杀的，不是 git 出错；报非零会让调用方把一次正常的截断当成失败。
    await writeFile(join(workspace.root, 'a.txt'), `${'x'.repeat(50_000)}\n`)

    const result = await runGitDiffCapped(workspace.root, diffArgs(false, undefined, false, []), 120)

    expect(result.truncated).toBe(true)
    expect([...result.text].length).toBe(120)
    expect(result.exitCode).toBe(0)
  })

  it('git 起不来时抛错', async () => {
    await expect(
      runGitDiffCapped(join(workspace.base, 'no-such-dir'), ['diff'], 100),
    ).rejects.toThrow(/failed to run git/)
  })
})
