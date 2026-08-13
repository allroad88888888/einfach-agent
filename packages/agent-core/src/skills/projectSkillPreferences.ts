// 项目 Skills 的工作区级启停偏好：规范化、更新与快照筛选。
// ---------------------------------------------------------------------------
// 这份偏好只保存「被停用的项目 skill 名」；缺席即启用，避免扫描快照与用户选择形成两份
// 状态。它是纯函数，供宿主设置持久化和运行时 tool context 共用，二者不会各写一套判据。

import type { ProjectSkillsSnapshot } from './projectSkills'

export type DisabledProjectSkillsByWorkspace = Record<string, readonly string[]>

const MAX_WORKSPACE_PREFERENCES = 128
const MAX_DISABLED_SKILLS_PER_WORKSPACE = 32
const MAX_WORKSPACE_ID_LENGTH = 128
const PROJECT_SKILL_NAME = /^project\/[a-z0-9][a-z0-9-]{0,63}$/

function isWorkspaceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_WORKSPACE_ID_LENGTH
}

function isProjectSkillName(value: string): boolean {
  return PROJECT_SKILL_NAME.test(value)
}

/** Drops malformed and stale persisted entries while retaining deterministic order. */
export function normalizeDisabledProjectSkills(value: unknown): DisabledProjectSkillsByWorkspace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}

  const normalized: Record<string, readonly string[]> = {}
  const workspaces = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

  for (const [workspaceId, names] of workspaces) {
    if (Object.keys(normalized).length >= MAX_WORKSPACE_PREFERENCES) break
    if (!isWorkspaceId(workspaceId) || !Array.isArray(names)) continue
    const skillNames = Array.from(new Set(
      names.filter((name): name is string => typeof name === 'string' && isProjectSkillName(name)),
    )).sort()
    if (skillNames.length > 0) {
      normalized[workspaceId] = skillNames.slice(0, MAX_DISABLED_SKILLS_PER_WORKSPACE)
    }
  }

  return normalized
}

/** Returns a normalized preference map after toggling one known project skill. */
export function setProjectSkillEnabled(
  preferences: DisabledProjectSkillsByWorkspace,
  workspaceId: string,
  skillName: string,
  enabled: boolean,
): DisabledProjectSkillsByWorkspace {
  const normalized = normalizeDisabledProjectSkills(preferences)
  if (!isWorkspaceId(workspaceId) || !isProjectSkillName(skillName)) return normalized

  const disabled = new Set(normalized[workspaceId] ?? [])
  if (enabled) disabled.delete(skillName)
  else disabled.add(skillName)

  const next: Record<string, readonly string[]> = { ...normalized }
  const values = [...disabled].sort().slice(0, MAX_DISABLED_SKILLS_PER_WORKSPACE)
  if (values.length > 0) next[workspaceId] = values
  else delete next[workspaceId]
  return next
}

/** Removes disabled entries from a scanned snapshot without mutating the cache. */
export function filterProjectSkillsSnapshot(
  snapshot: ProjectSkillsSnapshot | undefined,
  disabledSkillNames: readonly string[] | undefined,
): ProjectSkillsSnapshot | undefined {
  if (!snapshot || !disabledSkillNames || disabledSkillNames.length === 0) return snapshot
  const disabled = new Set(disabledSkillNames)
  const entries = snapshot.entries.filter((entry) => !disabled.has(entry.name))
  return entries.length === snapshot.entries.length ? snapshot : { ...snapshot, entries }
}
