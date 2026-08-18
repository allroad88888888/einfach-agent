// tools-skills/registry.ts —— 内置 skill 的内容、检索与 manifest 实现。
// ---------------------------------------------------------------------------
// TK4：skill 走 tool、不进 prompt —— 进 prompt 的只有清单元数据（name + 触发条件式
// description，见 buildSkillManifestText），正文与资源永远经 skill_read。
// 这里只负责「产出清单 + 提供读取」，不再做任何 harness 侧的匹配/预筛。
// 类型自包含（不 import runtime/state/UI），与 src/agent 版语义一致。
//
// 阶段 3（docs/skills-tree-blueprint.md「实施阶段」）：全量清单进稳定前缀，匹配交给模型自判 ——
// B04 行为 eval 实测（n=80/arm）manifest 命中 100%/误触 0%，关键词预筛 62.5%/12.5%，
// 故 pickSkillsForInput 已整体退役（预筛不作为叠加提示保留：名单本身就是「暗示该读」的噪声源）。
// description 因此必须写成「何时用…；何时不用…」，它是模型唯一的选择依据；triggers 降级为
// skill_search 的检索素材，不再参与任何请求组装。
//
// 阶段 1（docs/skills-tree-blueprint.md「数据模型」）：skill 除正文（L2）外可携带 L3 资源树。
// web 端资源是编译期 `?raw` 打包出的 Record<string, string>——没有真实文件系统，键即完整逻辑
// 相对路径，按 Record 精确匹配，不做任何路径解析/规范化（无穿越面，详见 readSkillResource
// 注释）。Tauri 真实文件系统 skills 目录是阶段 4 的范畴，不在本文件内。
//
// 阶段 4（project-skills-blueprint.md）：buildSkillManifestText 新增可选 snapshot 入参，
// 无快照/空快照时输出与今天逐字相同（web 端回归护栏）。项目段由调用方传入，本模块只负责拼。

import type { ProjectSkillsSnapshot, SkillSummary } from '@web-agent/core/skills'
import askUserQuestion from './ask-user-question.md?raw'
import dataVisualization from './data-visualization.md?raw'
import toolLoading from './tool-loading.md?raw'
import webChatAgent from './web-chat-agent.md?raw'
import planning from './planning.md?raw'
import planningEvaluationReference from './planning/references/evaluation.md?raw'

export type { SkillSummary } from '@web-agent/core/skills'

export interface SkillSearchMatch extends SkillSummary {
  /** Deterministic relevance score; larger values sort first. */
  score: number
  /** Metadata fields that contributed to the match. */
  matchedFields: Array<'name' | 'description' | 'trigger'>
}

export interface LoadedSkill extends SkillSummary {
  content: string
  /** 可读 L3 资源键列表（如 'references/evaluation.md'）；skill 无资源时为空数组。 */
  resources: string[]
}

type SkillSource = {
  name: string
  description: string
  triggers: string[]
  content: string
  /** 相对路径 → 编译期 `?raw` 打包的内容。键即完整逻辑路径，见文件头注释。 */
  resources?: Record<string, string>
}

const skillSources: SkillSource[] = [
  {
    name: 'planning',
    description:
      '何时用：任务跨多个阶段/模块、需要规划路线图、多步骤实施、架构调整、重构、迁移（migration）或并发协作时读我；何时不用：一步可完成、可直接回答的小改动。',
    triggers: ['plan', '规划', '阶段', '路线图', '多步骤', 'migration', '架构', '重构', '并发'],
    content: planning,
    resources: {
      'references/evaluation.md': planningEvaluationReference,
    },
  },
  {
    name: 'ask-user-question',
    description:
      '何时用：关键约束不明确、必须先向用户提问确认（ask user）才能继续时读我；何时不用：信息已够，或只是想同步进度、征求事后认可。',
    triggers: ['提问', '确认', '不明确', 'ask user'],
    content: askUserQuestion,
  },
  {
    name: 'tool-loading',
    description:
      '何时用：想弄清工具（tool）为何只给摘要、如何延迟加载（lazy loading）完整 schema、以及工具分类与调用纪律时读我；何时不用：正常调用一个已加载的工具。',
    triggers: ['tool', '工具', '延迟加载', 'lazy loading'],
    content: toolLoading,
  },
  {
    name: 'web-chat-agent',
    description:
      '何时用：需要确认本 Web chat agent（前端 runtime）的能力边界——支持什么、明确不支持什么时读我；何时不用：用户问的是业务问题本身。',
    triggers: ['web agent', 'chat', '前端', 'runtime'],
    content: webChatAgent,
  },
  {
    name: 'data-visualization',
    description:
      '何时用：回复里要给出图表、可视化（chart/echarts 绘图）或代码高亮时读我，按围栏格式让前端 Markdown 自动渲染；何时不用：纯文字结论，无需图表或代码块。',
    triggers: ['图表', '可视化', 'chart', 'echarts', '绘图', '代码高亮'],
    content: dataVisualization,
  },
]

/** 不用 localeCompare：清单进的是可缓存的稳定前缀，字节顺序不能受宿主 locale/ICU 影响。 */
function compareSkillName(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 组全量 skill 清单文本（L1）——调用方（modelRun）把它作为稳定前缀的一段发给模型。
 *
 * ★ 字节稳定是本函数的核心契约 ★：内容只依赖 registry 注册态（名字 + description），
 * 不含本轮输入、时间或任何运行期状态；名字按字节序排序，同一注册态下重复调用逐字相同。
 * 于是它可以和固定 system 一起待在 append-only 历史【之前】，运行期永不换位置；只有真的
 * 增删/改写 skill 才让前缀字节变化（contextCache 归因 profile_changed，一次性全量 miss）。
 *
 * 只放元数据：正文（L2）与资源（L3）必须经 skill_read 读取（TK4）。
 */
export function buildSkillManifestText(snapshot?: ProjectSkillsSnapshot): string {
  const builtinLines = skillSources
    .map((skill) => ({ name: skill.name, description: skill.description }))
    .sort((left, right) => compareSkillName(left.name, right.name))
    .map((skill) => `· ${skill.name} — ${skill.description}`)

  const projectSection = buildProjectManifestSection(snapshot)

  return [
    '可用 skills（正文不在此展示，需要时用 skill_read 按名称读取；带资源的 skill 会在正文返回可读资源目录）：',
    ...builtinLines,
    ...projectSection,
  ].join('\n')
}

/**
 * 组扫描段清单文本（L1）。snapshot 为 undefined 或 entries 为空时返回空数组——
 * 保证 web 端清单逐字等于今天输出（零回归）。
 *
 * 工作区与用户目录**分两段**：两者的来源与可信度不同（前者跟着仓库走、可能来自任何一个
 * clone 下来的项目；后者是本机主人自己放的），合成一段会让模型无从分辨，而这正是
 * project-skills-blueprint「来源可见」那条要的东西。
 */
const SCOPE_HEADINGS = {
  project: '以下由当前 workspace 提供（非内置，可信度低于上方内置 skills）：',
  user: '以下由本机用户目录提供（非内置，可信度低于上方内置 skills）：',
} as const

function buildProjectManifestSection(snapshot?: ProjectSkillsSnapshot): string[] {
  if (!snapshot || snapshot.entries.length === 0) return []

  return (['project', 'user'] as const).flatMap((scope) => {
    const lines = snapshot.entries
      .filter((entry) => entry.scope === scope)
      .sort((left, right) => compareSkillName(left.name, right.name))
      .map((entry) => `· ${entry.name} — ${entry.description}`)
    return lines.length > 0 ? ['', SCOPE_HEADINGS[scope], ...lines] : []
  })
}

export function listSkillSummaries(): SkillSummary[] {
  return skillSources.map(({ name, description, triggers }) => ({ name, description, triggers }))
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function queryTokens(query: string): string[] {
  return Array.from(new Set(
    query
      .split(/[\s,，。！？!?、:：;；()[\]{}"'“”‘’/\\|]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  ))
}

/**
 * Ranked skill retrieval used by skill_search. Exact name/trigger hits outrank
 * substrings, while description-only hits stay useful but lower.
 *
 * `extra` 让调用方把内置之外的条目（当前是项目 skills）并进同一次排名。评分规则只此一份：
 * 让工具侧另写一套「项目 skills 的评分」必然与这里漂移，同一个 query 在两类 skill 上的
 * 排序就不再可比。
 */
export function searchSkills(query: string, extra: readonly SkillSummary[] = []): SkillSearchMatch[] {
  const normalizedQuery = normalizedSearchText(query)
  const tokens = queryTokens(normalizedQuery)

  return [...listSkillSummaries(), ...extra]
    .map((skill): SkillSearchMatch | undefined => {
      const name = normalizedSearchText(skill.name)
      const description = normalizedSearchText(skill.description)
      const triggers = skill.triggers.map(normalizedSearchText)
      const matchedFields = new Set<SkillSearchMatch['matchedFields'][number]>()
      let score = 0

      if (!normalizedQuery) return { ...skill, score, matchedFields: [] }

      if (name === normalizedQuery) {
        score += 120
        matchedFields.add('name')
      } else if (name.includes(normalizedQuery) || normalizedQuery.includes(name)) {
        score += 70
        matchedFields.add('name')
      }

      for (const trigger of triggers) {
        if (trigger === normalizedQuery) {
          score += 100
          matchedFields.add('trigger')
        } else if (trigger.includes(normalizedQuery) || normalizedQuery.includes(trigger)) {
          score += 55
          matchedFields.add('trigger')
        }
      }

      if (description.includes(normalizedQuery)) {
        score += 40
        matchedFields.add('description')
      }

      for (const token of tokens) {
        if (token === normalizedQuery) continue
        if (name.includes(token) || token.includes(name)) {
          score += 24
          matchedFields.add('name')
        }
        if (triggers.some((trigger) => trigger.includes(token) || token.includes(trigger))) {
          score += 18
          matchedFields.add('trigger')
        }
        if (description.includes(token)) {
          score += 8
          matchedFields.add('description')
        }
      }

      if (score === 0) return undefined
      return { ...skill, score, matchedFields: Array.from(matchedFields).sort() }
    })
    .filter((skill): skill is SkillSearchMatch => skill !== undefined)
    .sort((left, right) => right.score - left.score || compareSkillName(left.name, right.name))
}

export function readSkill(name: string): LoadedSkill | undefined {
  const source = skillSources.find((skill) => skill.name === name)
  if (!source) return undefined

  return {
    name: source.name,
    description: source.description,
    triggers: source.triggers,
    content: source.content,
    resources: Object.keys(source.resources ?? {}),
  }
}

/** 单资源治理上限：64KB，按字符数计（非字节）——见 docs/skills-tree-blueprint.md「数据模型」。 */
export const SKILL_RESOURCE_MAX_CHARS = 65536

/**
 * 纯函数：内容超限时截断到上限并附中文说明行；未超限原样返回，不复制字符串。
 *
 * 单独导出是为了让测试无需构造真实的超大 skill 资源即可验证截断阈值——registry 里的资源都是
 * 编译期 `?raw` 打包的静态内容，没有天然超过 64KB 的样本；直接给本函数灌入合成的超长字符串
 * 即可单测截断逻辑（对应蓝图阶段 1 的测试建议）。
 */
export function truncateSkillResourceContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= SKILL_RESOURCE_MAX_CHARS) {
    return { content, truncated: false }
  }
  const notice = '\n\n[内容超过 64KB 上限，已截断；如需完整内容，请拆分为更小的资源文件后分别读取。]'
  return { content: content.slice(0, SKILL_RESOURCE_MAX_CHARS) + notice, truncated: true }
}

export type SkillResourceResult =
  | { ok: true; name: string; resourcePath: string; content: string; truncated: boolean }
  | { ok: false; error: string; availableResources?: string[] }

/**
 * 读取某个 skill 的单个 L3 资源。
 *
 * 资源键按 Record 精确匹配——不做任何路径解析/规范化（不处理 '.'/'..'、不归一化前导斜杠、无
 * 符号链接语义）。这是有意设计：web 端资源在编译期由 `?raw` 打包进 Record<string, string>，
 * 不存在真实文件系统，因此天然没有路径穿越面；对键做「规范化」在这里没有安全含义，只会引入
 * 虚假的复杂度和不一致的匹配行为。真实文件系统语义（canonicalize + 根目录约束）留给阶段 4
 * （Tauri 文件系统 skills 目录），与本函数无关。
 */
export function readSkillResource(name: string, resourcePath: string): SkillResourceResult {
  const source = skillSources.find((skill) => skill.name === name)
  if (!source) {
    return { ok: false, error: `skill not found: ${name}` }
  }

  const resources = source.resources ?? {}
  if (!Object.prototype.hasOwnProperty.call(resources, resourcePath)) {
    const availableResources = Object.keys(resources)
    const availableText = availableResources.length > 0 ? availableResources.join(', ') : '(none)'
    return {
      ok: false,
      error: `resource not found: ${resourcePath} (skill: ${name}); available resources: ${availableText}`,
      availableResources,
    }
  }

  const { content, truncated } = truncateSkillResourceContent(resources[resourcePath])
  return { ok: true, name, resourcePath, content, truncated }
}
