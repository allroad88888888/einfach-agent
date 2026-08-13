// tools-interaction —— @web-agent/tools-interaction：interaction 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @web-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@web-agent/core/tools'
import { askUserQuestionTool } from './ask-user-question/ask-user-question'
import { browserActionTool } from './browser-action/browser-action'
import { saveFileTool } from './save-file/save-file'

export { askUserQuestionTool, browserActionTool, saveFileTool }

/** 把 interaction 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerInteractionTools(registry: ToolRegistry): void {
  for (const tool of [askUserQuestionTool, browserActionTool, saveFileTool]) {
    registry.register(tool)
  }
}
