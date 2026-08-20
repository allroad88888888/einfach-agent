// skills/projectSkillsSnapshot.ts —— 多个扫描根的结果合成一份 skills 快照（纯函数，零 IO）
// ---------------------------------------------------------------------------
// 单个 SKILL.md → 条目在 projectSkills.ts；扫描 IO 在 tools-skills 的 loader。
// 本模块只做「若干扫描结果 → 一份快照」：同作用域撞名裁决、按作用域截断、诊断合并。

import {
  scanRootLabel,
  type ProjectSkillEntry,
  type ProjectSkillOrigin,
  type ProjectSkillScope,
  type ProjectSkillsSnapshot,
} from './projectSkills'

/**
 * 单个作用域最多加载的 skill 数；超出按名字字节序截断。
 *
 * 上限**按作用域各算一份**：主目录里堆了几十个 skill 时，工作区自己的 skill 不该因此被挤掉——
 * 它们是两批互不相干的内容，共用一个计数只会让「项目 skill 忽然消失」这种故障以主目录为诱因。
 *
 * ★ 为什么是 100 而不是更小的数 ★ —— 这道闸防的是「一个失控目录把上下文撑爆」，不是替用户
 * 挑 skill。进 L1 清单的只有名字与 description（正文与资源仍要 skill_read），一条约几十 token，
 * 所以把闸放宽的代价是有界的。真正该管「这个 skill 在这个项目里用不用得上」的是工作区级的启停
 * 偏好（projectSkillPreferences.ts + 设置面板的 ProjectSkillsPanel），那是用户的选择，不该由
 * 一个截断常量替他做——而按字节序截断恰恰是最没有道理的一种替他做。
 */
export const MAX_PROJECT_SKILLS = 100

/** 一个扫描根（作用域 × 目录）的产出。 */
export interface ProjectSkillScanResult {
  scope: ProjectSkillScope
  origin: ProjectSkillOrigin
  entries: ProjectSkillEntry[]
  diagnostics: string[]
}

const SCOPES: readonly ProjectSkillScope[] = ['project', 'user']

function byName(left: ProjectSkillEntry, right: ProjectSkillEntry): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

/**
 * 合成快照。
 *
 * 撞名只在**同一作用域**内裁决（`.webAgent` 胜 `.claude`，与前一版一致）：跨作用域的名字前缀
 * 不同，工作区的 `deploy` 与主目录的 `deploy` 是清单里两条并存的项。
 */
export function resolveProjectSkills(opts: {
  workspaceRoot: string
  /** 用户级扫描根；没扫用户目录时缺省，快照里也不会有 user 条目。 */
  userSkillsRoot?: string
  scans: readonly ProjectSkillScanResult[]
}): ProjectSkillsSnapshot {
  const { workspaceRoot, userSkillsRoot, scans } = opts

  const diagnostics = scans.flatMap((scan) => scan.diagnostics)
  const entries: ProjectSkillEntry[] = []

  for (const scope of SCOPES) {
    const inScope = (origin: ProjectSkillOrigin) => scans
      .filter((scan) => scan.scope === scope && scan.origin === origin)
      .flatMap((scan) => scan.entries)

    const agentEntries = inScope('agent')
    const claudeEntries = inScope('claude')

    const agentNames = new Set(agentEntries.map((entry) => entry.name))
    const dedupedClaude: ProjectSkillEntry[] = []
    for (const entry of claudeEntries) {
      if (agentNames.has(entry.name)) {
        diagnostics.push(
          `${scanRootLabel(scope, 'claude')}/${entry.name.slice(scope.length + 1)}: `
          + `与 ${scanRootLabel(scope, 'agent')} 同名，后者胜，已跳过`,
        )
      } else {
        dedupedClaude.push(entry)
      }
    }

    const merged = [...agentEntries, ...dedupedClaude].sort(byName)
    entries.push(...merged.slice(0, MAX_PROJECT_SKILLS))
    if (merged.length > MAX_PROJECT_SKILLS) {
      const overflow = merged.slice(MAX_PROJECT_SKILLS)
      diagnostics.push(
        `${scope === 'user' ? '用户级' : '项目'} skills 总数 ${merged.length} `
        + `超过上限 ${MAX_PROJECT_SKILLS}，以下 skill 已被截断：`
        + `${overflow.map((entry) => entry.name).join(', ')}`,
      )
    }
  }

  return userSkillsRoot
    ? { workspaceRoot, userSkillsRoot, entries, diagnostics }
    : { workspaceRoot, entries, diagnostics }
}

export function emptyProjectSkillsSnapshot(workspaceRoot: string): ProjectSkillsSnapshot {
  return { workspaceRoot, entries: [], diagnostics: [] }
}
