import type { DisabledProjectSkillsByWorkspace } from '../skills/projectSkillPreferences'
import type { SessionMeta, WorkspaceMeta } from './core.type'

export const DEFAULT_WORKSPACE_NAME = '默认工作区'

export function normalizeWorkspaceRoot(root?: string): string | undefined {
  const trimmed = root?.trim()
  if (!trimmed) return undefined
  if (/^[A-Za-z]:[\\/]$/.test(trimmed) || trimmed === '/') return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

export function deriveWorkspaceName(root?: string): string {
  const normalized = normalizeWorkspaceRoot(root)
  if (!normalized) return DEFAULT_WORKSPACE_NAME
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  const leaf = parts.at(-1) ?? normalized
  const chars = Array.from(leaf)
  if (chars.length <= 40) return leaf
  // 目录名过长时保留末尾，通常版本号/项目后缀比共同前缀更有辨识度。
  return `…${chars.slice(-39).join('')}`
}

export function resolveSessionWorkspaceRoot(
  session: SessionMeta | undefined,
  workspaces: Record<string, WorkspaceMeta>,
): string | undefined {
  const workspaceRoot = session?.workspaceId
    ? workspaces[session.workspaceId]?.rootPath
    : undefined
  return normalizeWorkspaceRoot(workspaceRoot ?? session?.workspaceRoot)
}

/**
 * 该会话所属 workspace 上被停用的项目 skill 名单；未绑定 workspace 或无停用项时为 undefined。
 *
 * 只此一处判据：清单（modelTurnPrefix 的 skillManifest 段）与 ToolContext 的 skills 入口
 * （toolContext/skillsCapabilities.ts）必须对「这个 skill 停用了吗」给出同一个答案——各写一份的
 * 后果是模型在清单里看不到某个 skill、skill_read 却仍读得到它（或反过来）。
 */
export function sessionDisabledProjectSkills(
  session: SessionMeta | undefined,
  disabledByWorkspace: DisabledProjectSkillsByWorkspace,
): readonly string[] | undefined {
  return session?.workspaceId ? disabledByWorkspace[session.workspaceId] : undefined
}
