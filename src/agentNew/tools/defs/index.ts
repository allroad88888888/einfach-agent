// tools/defs/index.ts —— 注册全部内置工具到单例工厂（TOOLS-SPEC §9）。
// 副作用式注册：import 本文件即把内置工具挂进 toolRegistry。批量生成 = 新增 defs/<name>.ts + 这里加一行。
import { toolRegistry } from '../registry'
import { skillSearchTool } from './skill-search'
import { skillReadTool } from './skill-read'
import { askUserQuestionTool } from './ask-user-question'
import { browserActionTool } from './browser-action'
import { saveFileTool } from './save-file'

for (const tool of [skillSearchTool, skillReadTool, askUserQuestionTool, browserActionTool, saveFileTool]) {
  toolRegistry.register(tool)
}
