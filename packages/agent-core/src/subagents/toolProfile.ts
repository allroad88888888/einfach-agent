import { isSubagentHistoryTool, SUBAGENT_HISTORY_TOOLS } from './historyToolProfile'

/**
 * 子 agent 工具档位（全序能力阶梯）：
 *   · delegate_only    —— 只能 delegate_agent。
 *   · workspace_read   —— 追加只读文件工具。
 *   · workspace_verify —— 再追加 run_verification_command，用于核验型子 agent 取得真实执行证据。
 */
export const SUBAGENT_TOOL_PROFILES = [
  'delegate_only',
  'workspace_read',
  'workspace_verify',
] as const

export type SubagentToolProfile = (typeof SUBAGENT_TOOL_PROFILES)[number]

export const DEFAULT_SUBAGENT_TOOL_PROFILE: SubagentToolProfile = 'delegate_only'

export const SUBAGENT_WORKSPACE_READ_TOOLS = [
  'read_file',
  'list_files',
  'search_files',
  'rg_search',
] as const

/**
 * workspace_verify 档位独有的验证命令执行工具。
 */
export const SUBAGENT_VERIFICATION_TOOL = 'run_verification_command'

/**
 * 档位是【全序】的能力阶梯：delegate_only ⊂ workspace_read ⊂ workspace_verify。
 * 父档位的秩必须 ≥ 子档位，后代只能继承或收窄，永远不能加宽。
 */
const SUBAGENT_TOOL_PROFILE_RANK: Record<SubagentToolProfile, number> = {
  delegate_only: 0,
  workspace_read: 1,
  workspace_verify: 2,
}

export function subagentAllowedTools(profile: SubagentToolProfile): readonly string[] {
  switch (profile) {
    case 'workspace_verify':
      return ['delegate_agent', ...SUBAGENT_HISTORY_TOOLS, ...SUBAGENT_WORKSPACE_READ_TOOLS,
        SUBAGENT_VERIFICATION_TOOL]
    case 'workspace_read':
      return ['delegate_agent', ...SUBAGENT_HISTORY_TOOLS, ...SUBAGENT_WORKSPACE_READ_TOOLS]
    case 'delegate_only':
      return ['delegate_agent', ...SUBAGENT_HISTORY_TOOLS]
    default:
      return ['delegate_agent']
  }
}

export function canNarrowSubagentToolProfile(
  inherited: SubagentToolProfile,
  requested: SubagentToolProfile,
): boolean {
  const inheritedRank = SUBAGENT_TOOL_PROFILE_RANK[inherited]
  const requestedRank = SUBAGENT_TOOL_PROFILE_RANK[requested]
  // 未知档位（例如被旧数据或外部调用方塞进来的字符串）一律 fail-closed。
  if (inheritedRank === undefined || requestedRank === undefined) return false
  return requestedRank <= inheritedRank
}

export function isSubagentWorkspaceReadTool(name: string): boolean {
  // The execution loop historically calls this predicate for every read-only profile tool.
  // History reads are profile-independent, but remain in this combined gate to keep that loop small.
  return isSubagentHistoryTool(name)
    || (SUBAGENT_WORKSPACE_READ_TOOLS as readonly string[]).includes(name)
}

export function isSubagentVerificationTool(name: string): boolean {
  return name === SUBAGENT_VERIFICATION_TOOL
}
