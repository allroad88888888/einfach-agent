// @web-agent/core/skills 的公开入口：内置 skills registry 契约 + 项目 Skills（L3）纯函数层。
//
// projectSkillPreferences（工作区级禁用清单）在 S4 落卡时还是另一条工作线的在途模块，故当时
// 未表态；该模块已落库（1908f87），S9 按「一条 subpath 只有一个归属」把它的公开面并进本 barrel：
// `apps/web/src/settings/*` 三处消费方改走 `@web-agent/core/skills`，不再深导入。
// `filterProjectSkillsSnapshot` 不收——它只有 core 内部（runtime/toolContext）一个消费方。

export {
  emptySkillsRegistry,
  type SkillsRegistry,
  type SkillSummary,
} from './contracts'

export {
  buildProjectSkillEntry,
  FRONTMATTER_READ_LIMIT,
  MAX_DESCRIPTION_CHARS,
  MAX_PROJECT_RESOURCES_PER_SKILL,
  parseFrontmatter,
  PROJECT_RESOURCE_EXTENSIONS,
  sanitizeDescription,
  sanitizeName,
  scanRootLabel,
  skillScopeFromName,
  splitFrontmatter,
  type ProjectSkillEntry,
  type ProjectSkillFrontmatter,
  type ProjectSkillOrigin,
  type ProjectSkillScope,
  type ProjectSkillsSnapshot,
} from './projectSkills'

export {
  emptyProjectSkillsSnapshot,
  MAX_PROJECT_SKILLS,
  resolveProjectSkills,
  type ProjectSkillScanResult,
} from './projectSkillsSnapshot'

export {
  // apps/web: settings/{persistence,config} —— 读回持久化偏好时的规范化入口
  normalizeDisabledProjectSkills,
  // apps/web: settings/projectSkillsCommands —— 面板启停单个项目 skill
  setProjectSkillEnabled,
  // 上面两个函数的入参/返回类型；apps/web: settings/config 的 AppSettings 字段类型
  type DisabledProjectSkillsByWorkspace,
} from './projectSkillPreferences'
