// tools-fs —— @web-agent/tools-fs：fs 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @web-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { readFileTool } from './read-file/read-file'
import { listFilesTool } from './list-files/list-files'
import { searchFilesTool } from './search-files/search-files'
import { rgSearchTool } from './rg-search/rg-search'
import { applyPatchTool } from './apply-patch/apply-patch'
import { writeFileTool } from './write-file/write-file'

export { readFileTool, listFilesTool, searchFilesTool, rgSearchTool, applyPatchTool, writeFileTool }

/** 把 fs 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerFsTools(registry: ToolRegistry): void {
  for (const tool of [readFileTool, listFilesTool, searchFilesTool, rgSearchTool, applyPatchTool, writeFileTool]) {
    registry.register(tool)
  }
}
