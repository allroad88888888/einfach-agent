// tools-shell —— @einfach-agent/tools-shell：shell 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @einfach-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { shellMacosTool } from './shell-macos/shell-macos'
import { shellLinuxTool } from './shell-linux/shell-linux'
import { shellPowershellTool } from './shell-powershell/shell-powershell'
import { runTaskTool } from './run-task/run-task'
import { runVerificationCommandTool } from './run-verification-command/run-verification-command'
import { gitDiffReviewTool } from './git-diff-review/git-diff-review'

export {
  shellMacosTool,
  shellLinuxTool,
  shellPowershellTool,
  runTaskTool,
  runVerificationCommandTool,
  gitDiffReviewTool,
}

/** 把 shell 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerShellTools(registry: ToolRegistry): void {
  for (const tool of [
    shellMacosTool,
    shellLinuxTool,
    shellPowershellTool,
    runTaskTool,
    runVerificationCommandTool,
    gitDiffReviewTool,
  ]) {
    registry.register(tool)
  }
}
