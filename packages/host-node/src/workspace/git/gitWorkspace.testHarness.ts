// 测试脚手架：一个真实的临时 git 仓库（外加一个「根外」的兄弟目录）
// ---------------------------------------------------------------------------
// 形状与 Rust 侧 `workspace_git_test_support.rs` 的 `init_git_workspace` 一致，只是基座换成了
// workspace/common 的 `createTempWorkspace`——它多给一个 root 之外的 `base` 目录，越界测试需要
// 真实的根外文件才有意义（只用字符串拼路径测不出 symlink 逃逸，词法上它根本不越界）。
//
//   base/                 ← 「根外」
//     workspace/          ← workspace root，也是 git 仓库根
//       a.txt / b.txt     ← 两个带独特标记的文件，已提交为基线
//
// 不 mock git：这一域的全部风险都在「真实的 git 怎么解释我们给的参数」上，换成假 git 等于把
// 被测的那件事替换掉。

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

const execFileAsync = promisify(execFile)

/** 真跑一条 git 命令（搭台用，非被测代码）；失败即抛，便于定位。 */
export async function runSetupGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd })
  return stdout
}

/** 临时 workspace + 已初始化的 git 仓库 + 一个初始提交。 */
export async function createGitWorkspace(): Promise<TempWorkspace> {
  const workspace = await createTempWorkspace()
  await writeFile(join(workspace.root, 'a.txt'), 'ALPHA_MARKER\n')
  await writeFile(join(workspace.root, 'b.txt'), 'BETA_MARKER\n')
  await runSetupGit(workspace.root, ['init', '-q'])
  // 显式设本地身份，避免依赖全局 git config（CI / 干净机器上可能没配）。
  await runSetupGit(workspace.root, ['config', 'user.email', 'test@example.com'])
  await runSetupGit(workspace.root, ['config', 'user.name', 'Test'])
  await runSetupGit(workspace.root, ['add', '-A'])
  // 关签名，避免全局 commit.gpgsign=true 但无密钥时提交失败。
  await runSetupGit(workspace.root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
  return workspace
}
