import type { SubagentToolProfile } from './types'

/** Read-only history tools available to every child-agent profile. */
export const SUBAGENT_HISTORY_TOOLS = [
  'list_agent_histories',
  'list_agent_history_items',
  'read_agent_history_item',
  'search_agent_histories',
] as const

export function isSubagentHistoryTool(name: string): boolean {
  return (SUBAGENT_HISTORY_TOOLS as readonly string[]).includes(name)
}

export function subagentProfileAllowsHistory(profile: SubagentToolProfile | undefined): boolean {
  return profile === undefined || profile === 'delegate_only'
    || profile === 'workspace_read' || profile === 'workspace_verify'
}
