// tools-skills —— @web-agent/tools-skills：skills 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @web-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@web-agent/core/tools'
import type { SkillsRegistry } from '@web-agent/core/skills'
import { skillManifestTool } from './skill-manifest/skill-manifest'
import { skillSearchTool } from './skill-search/skill-search'
import { skillReadTool } from './skill-read/skill-read'
import { buildSkillManifestText, listSkillSummaries } from './registry'

export { skillManifestTool, skillSearchTool, skillReadTool }
export { buildProjectSkillsProvider } from './projectSkillsProvider'
export {
  buildSkillManifestText,
  listSkillSummaries,
  readSkill,
  readSkillResource,
  searchSkills,
} from './registry'

/** 供宿主注入 CoreInstance 的内置 skill registry。 */
export const builtInSkillsRegistry: SkillsRegistry = {
  buildManifestText: buildSkillManifestText,
  list: listSkillSummaries,
}

/** 把 skills 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerSkillsTools(registry: ToolRegistry): void {
  for (const tool of [skillManifestTool, skillSearchTool, skillReadTool]) {
    registry.register(tool)
  }
}
