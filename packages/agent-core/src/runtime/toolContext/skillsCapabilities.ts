// runtime/toolContext/skillsCapabilities.ts —— ctx 上的 Skills 只读入口（内置 + 扫描来的）。
// 扫描快照在 ctx 构造期取一次并按会话禁用列表过滤；workspaceRoot 为空时降级为仅内置。
// 这里**只读缓存、不触发扫描**：扫描由 buildStableModelPrefix 组 L1 清单时 ensure 一次（C7），
// 工具跑起来时快照必然已在。曾经还有一个 `ensure()` 入口，那是给已删除的 skill_manifest 到点工具
// 用的，随它一起去掉——留着就是一条没有调用方的扫描通路。
// resolveScannedSkill 只按名字查扫描期生成的白名单，绝不用模型给的字符串拼路径——这是 L3 资源
// 没有穿越面的原因。

import type { ToolContext } from '../../tools/types'
import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom } from '../../state/rootStore'
import { filterProjectSkillsSnapshot } from '../../skills/projectSkillPreferences'
import {
  skillScopeFromName,
  type ProjectSkillEntry,
  type ProjectSkillsSnapshot,
} from '../../skills/projectSkills'
import type { SkillSummary } from '../../skills/contracts'
import { sessionDisabledProjectSkills } from '../../state/workspaceState'
import type { CoreInstance } from '../core/coreInstance'
import {
  captureRunCapabilitySnapshot,
  type RunCapabilitySnapshot,
} from '../turnToolVisibility'

export type SkillsCapabilities = Pick<ToolContext, 'skills'>

export interface RunSkillSnapshot {
  readonly summaries: readonly SkillSummary[]
  readonly projectEntries: readonly ProjectSkillEntry[]
}

export function captureRunSkillSnapshot(
  builtins: readonly SkillSummary[],
  projectSkills: ProjectSkillsSnapshot | undefined,
  capabilities: RunCapabilitySnapshot,
): RunSkillSnapshot {
  const summaries = new Map<string, SkillSummary>()
  for (const skill of builtins) {
    if (capabilities.allowsSkill(skill.name)) summaries.set(skill.name, { ...skill, triggers: [...skill.triggers] })
  }
  const projectEntries = (projectSkills?.entries ?? [])
    .filter((entry) => capabilities.allowsSkill(entry.name))
    .map((entry) => ({ ...entry, triggers: [...entry.triggers], resources: { ...entry.resources } }))
  for (const entry of projectEntries) {
    if (!summaries.has(entry.name)) {
      summaries.set(entry.name, {
        name: entry.name,
        description: entry.description,
        triggers: [...entry.triggers],
      })
    }
  }
  return Object.freeze({
    summaries: Object.freeze([...summaries.values()]),
    projectEntries: Object.freeze(projectEntries),
  })
}

const SKILL_MANIFEST_HEADER =
  '可用 skills（正文不在此展示，需要时用 skill_read 按名称读取；带资源的 skill 会在正文返回可读资源目录）：'

const SKILL_SCOPE_HEADINGS = {
  project: '以下由当前 workspace 提供（非内置，可信度低于上方内置 skills）：',
  user: '以下由本机用户目录提供（非内置，可信度低于上方内置 skills）：',
} as const

function compareSkillName(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

/** Preserves legacy prose, but renders restricted manifests only from the allowed snapshot. */
export function buildRunSkillManifestText(
  manifest: string,
  snapshot: RunSkillSnapshot,
  capabilities: RunCapabilitySnapshot,
): string {
  if (capabilities.allowedSkillNames === undefined) return manifest

  const projectNames = new Set(snapshot.projectEntries.map((entry) => entry.name))
  const builtinLines = snapshot.summaries
    .filter((skill) => !projectNames.has(skill.name))
    .sort(compareSkillName)
    .map((skill) => `· ${skill.name} — ${skill.description}`)
  const scopedLines = (['project', 'user'] as const).flatMap((scope) => {
    const lines = snapshot.projectEntries
      .filter((entry) => entry.scope === scope)
      .sort(compareSkillName)
      .map((entry) => `· ${entry.name} — ${entry.description}`)
    return lines.length > 0 ? ['', SKILL_SCOPE_HEADINGS[scope], ...lines] : []
  })
  return [SKILL_MANIFEST_HEADER, ...builtinLines, ...scopedLines].join('\n')
}

export function createSkillsCapabilities(deps: {
  sessionId: string
  core: CoreInstance
  workspaceRoot: string | undefined
  snapshot?: RunSkillSnapshot
  capabilitySnapshot?: RunCapabilitySnapshot
}): SkillsCapabilities {
  const { sessionId, core, workspaceRoot } = deps

  // Skills 只读入口：合并内置 + 项目快照（workspaceRoot 为空时降级为仅内置）。
  // 停用名单与 L1 清单读同一个判据（sessionDisabledProjectSkills），否则会出现
  // 「清单里没有、skill_read 却读得到」这种两边不一致。
  const disabledProjectSkills = sessionDisabledProjectSkills(
    core.rootStore.getter(sessionsAtom)[sessionId],
    core.rootStore.getter(disabledProjectSkillsByWorkspaceAtom),
  )
  const projectSkillsSnapshot = workspaceRoot
    ? filterProjectSkillsSnapshot(core.projectSkills.get(workspaceRoot), disabledProjectSkills)
    : undefined
  const session = core.rootStore.getter(sessionsAtom)[sessionId]
  const capabilities = deps.capabilitySnapshot
    ?? captureRunCapabilitySnapshot(session?.capabilityPolicy)
  const snapshot = deps.snapshot ?? captureRunSkillSnapshot(
    core.skillRegistry.list(),
    projectSkillsSnapshot,
    capabilities,
  )
  const snapshotNames = new Set(snapshot.summaries.map((skill) => skill.name))

  const skills = {
    isAllowed: (name: string) => capabilities.state === 'legacy-unrestricted'
      || (capabilities.allowsSkill(name) && snapshotNames.has(name)),
    list() {
      return snapshot.summaries.map((skill) => ({ ...skill, triggers: [...skill.triggers] }))
    },
    resolveScannedSkill(name: string) {
      if (!skillScopeFromName(name)) return undefined
      const entry = snapshot.projectEntries.find((candidate) => candidate.name === name)
      if (!entry) return undefined
      return { filePath: entry.filePath, resources: entry.resources, rootPath: entry.rootPath }
    },
    resolveConfiguredSkill(name: string) {
      const skill = session?.agentProfile?.skillContents.find((candidate) => candidate.name === name)
      if (!skill || !capabilities.allowsSkill(name)) return undefined
      return { content: skill.content, resources: skill.resources }
    },
  }
  return {
    skills,
  }
}
