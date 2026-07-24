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
