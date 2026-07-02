// tools/register.ts —— 注册全部内置工具到单例工厂（TOOLS-SPEC §9）。
// 副作用式注册：import 本文件即把内置工具挂进 toolRegistry。批量生成 = 新增 tools/<name>/<name>.ts + 这里加一行。
import { toolRegistry } from './registry'
import { skillSearchTool } from './skill-search/skill-search'
import { skillReadTool } from './skill-read/skill-read'
import { askUserQuestionTool } from './ask-user-question/ask-user-question'
import { browserActionTool } from './browser-action/browser-action'
import { saveFileTool } from './save-file/save-file'
import { shellMacosTool } from './shell-macos/shell-macos'
import { shellLinuxTool } from './shell-linux/shell-linux'
import { shellPowershellTool } from './shell-powershell/shell-powershell'
import { readFileTool } from './read-file/read-file'
import { listFilesTool } from './list-files/list-files'
import { searchFilesTool } from './search-files/search-files'
import { applyPatchTool } from './apply-patch/apply-patch'
import { writeFileTool } from './write-file/write-file'
import { gitDiffReviewTool } from './git-diff-review/git-diff-review'

for (const tool of [
  skillSearchTool,
  skillReadTool,
  askUserQuestionTool,
  browserActionTool,
  saveFileTool,
  shellMacosTool,
  shellLinuxTool,
  shellPowershellTool,
  readFileTool,
  listFilesTool,
  searchFilesTool,
  applyPatchTool,
  writeFileTool,
  gitDiffReviewTool,
]) {
  toolRegistry.register(tool)
}
