import type { SubagentToolProfile } from './types'

export const DEFAULT_SUBAGENT_TOOL_PROFILE: SubagentToolProfile = 'delegate_only'

export const SUBAGENT_TOOL_PROFILES: readonly SubagentToolProfile[] = [
  'delegate_only',
  'workspace_read',
]

export const SUBAGENT_WORKSPACE_READ_TOOLS = [
  'read_file',
  'list_files',
  'search_files',
  'rg_search',
] as const

export function subagentAllowedTools(profile: SubagentToolProfile): readonly string[] {
  return profile === 'workspace_read'
    ? ['delegate_agent', ...SUBAGENT_WORKSPACE_READ_TOOLS]
    : ['delegate_agent']
}

export function canNarrowSubagentToolProfile(
  inherited: SubagentToolProfile,
  requested: SubagentToolProfile,
): boolean {
  return inherited === 'workspace_read' || requested === 'delegate_only'
}

export function isSubagentWorkspaceReadTool(name: string): boolean {
  return (SUBAGENT_WORKSPACE_READ_TOOLS as readonly string[]).includes(name)
}
