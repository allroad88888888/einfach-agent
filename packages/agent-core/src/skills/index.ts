// @web-agent/core/skills 的公开入口：内置 skills registry 契约 + 项目 Skills（L3）纯函数层。
//
// 不导出 projectSkillPreferences（禁用清单读写）——它是另一条工作线在途的新模块，尚未落库，
// 不属于本卡认领的公开面（见 docs/core-surface-issues.md S4 卡"执行警戒"）。

export {
  emptySkillsRegistry,
  type SkillsRegistry,
  type SkillSummary,
} from './contracts'

export {
  buildProjectSkillEntry,
  emptyProjectSkillsSnapshot,
  FRONTMATTER_READ_LIMIT,
  MAX_DESCRIPTION_CHARS,
  MAX_PROJECT_RESOURCES_PER_SKILL,
  MAX_PROJECT_SKILLS,
  parseFrontmatter,
  PROJECT_RESOURCE_EXTENSIONS,
  resolveProjectSkills,
  sanitizeDescription,
  sanitizeName,
  splitFrontmatter,
  type ProjectSkillEntry,
  type ProjectSkillFrontmatter,
  type ProjectSkillOrigin,
  type ProjectSkillsSnapshot,
} from './projectSkills'
