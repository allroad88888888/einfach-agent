import type { ProjectSkillsSnapshot } from './projectSkills'

/** 可由工具契约和运行时安全依赖的 skill 摘要。 */
export interface SkillSummary {
  name: string
  description: string
  triggers: string[]
}

/** 内置 skill registry 的核心运行时契约。实现由 tools-skills 提供。 */
export interface SkillsRegistry {
  buildManifestText(projectSkills?: ProjectSkillsSnapshot): string
  list(): SkillSummary[]
}

/** 未装配 tools-skills 时的安全默认值。 */
export const emptySkillsRegistry: SkillsRegistry = {
  buildManifestText: () => '可用 skills：当前运行环境未装配内置 skills。',
  list: () => [],
}
