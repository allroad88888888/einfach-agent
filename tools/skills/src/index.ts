// tools-skills —— @einfach-agent/tools-skills：skills 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @einfach-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@einfach-agent/core/tools'
import type { SkillsRegistry } from '@einfach-agent/core/skills'
import { skillSearchTool } from './skill-search/skill-search'
import { skillReadTool } from './skill-read/skill-read'
import { buildSkillManifestText, listSkillSummaries } from './registry'

export { skillSearchTool, skillReadTool }
export { buildProjectSkillsProvider } from './projectSkillsProvider'
export {
  buildSkillManifestText,
  listSkillSummaries,
  readSkill,
  readSkillResource,
  searchSkills,
} from './registry'

/**
 * 供宿主注入 CoreInstance 的内置 skill registry。
 *
 * L1 清单**只经此槽**到达模型：core 的 buildStableModelPrefix 调 buildManifestText，把清单作为
 * 稳定前缀的一段发出（C7）。曾经另有一个 `skill_manifest` 的 sessionStart 到点工具产出同一份清单
 * 并投影进历史（a88ba16），迁回前缀时整个删掉——两处都出的话模型会收到两份清单，而挂在历史尾巴上
 * 的那份每轮都被新历史顶位，正是当年把它移进前缀要消灭的持续 cache miss。
 */
export const builtInSkillsRegistry: SkillsRegistry = {
  buildManifestText: buildSkillManifestText,
  list: listSkillSummaries,
}

/** 把 skills 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerSkillsTools(registry: ToolRegistry): void {
  for (const tool of [skillSearchTool, skillReadTool]) {
    registry.register(tool)
  }
}
