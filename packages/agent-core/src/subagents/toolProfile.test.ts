import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_TOOL_PROFILES,
  SUBAGENT_VERIFICATION_TOOL,
  canNarrowSubagentToolProfile,
  isSubagentVerificationTool,
  isSubagentWorkspaceReadTool,
  subagentAllowedTools,
} from './toolProfile'
import type { SubagentToolProfile } from './types'
import {
  SUBAGENT_HISTORY_TOOLS,
  isSubagentHistoryTool,
  subagentProfileAllowsHistory,
} from './historyToolProfile'

describe('subagent tool profiles', () => {
  it('三档全序：delegate_only ⊂ workspace_read ⊂ workspace_verify', () => {
    expect(SUBAGENT_TOOL_PROFILES).toEqual(['delegate_only', 'workspace_read', 'workspace_verify'])
    expect(subagentAllowedTools('delegate_only')).toEqual(['delegate_agent', ...SUBAGENT_HISTORY_TOOLS])
    expect(subagentAllowedTools('workspace_read')).toEqual([
      'delegate_agent', ...SUBAGENT_HISTORY_TOOLS,
      'read_file', 'list_files', 'search_files', 'rg_search',
    ])
    expect(subagentAllowedTools('workspace_verify')).toEqual([
      'delegate_agent', ...SUBAGENT_HISTORY_TOOLS,
      'read_file', 'list_files', 'search_files', 'rg_search',
      'run_verification_command',
    ])
  })

  it('workspace_verify 是 workspace_read 的真超集', () => {
    const verify = subagentAllowedTools('workspace_verify')
    for (const name of subagentAllowedTools('workspace_read')) {
      expect(verify).toContain(name)
    }
    expect(verify).toContain(SUBAGENT_VERIFICATION_TOOL)
  })

  it('收窄规则覆盖全序的每一对组合', () => {
    const order: SubagentToolProfile[] = ['delegate_only', 'workspace_read', 'workspace_verify']
    for (const [inheritedRank, inherited] of order.entries()) {
      for (const [requestedRank, requested] of order.entries()) {
        expect(canNarrowSubagentToolProfile(inherited, requested)).toBe(requestedRank <= inheritedRank)
      }
    }
  })

  it('workspace_read 不能加宽成 workspace_verify', () => {
    expect(canNarrowSubagentToolProfile('workspace_read', 'workspace_verify')).toBe(false)
    expect(canNarrowSubagentToolProfile('delegate_only', 'workspace_verify')).toBe(false)
    expect(canNarrowSubagentToolProfile('workspace_verify', 'workspace_read')).toBe(true)
  })

  it('未知档位 fail-closed', () => {
    expect(canNarrowSubagentToolProfile('write_all' as SubagentToolProfile, 'delegate_only')).toBe(false)
    expect(canNarrowSubagentToolProfile('workspace_verify', 'write_all' as SubagentToolProfile)).toBe(false)
    expect(subagentAllowedTools('write_all' as SubagentToolProfile)).toEqual(['delegate_agent'])
  })

  it('工具名判定互不重叠', () => {
    expect(isSubagentVerificationTool('run_verification_command')).toBe(true)
    expect(isSubagentVerificationTool('shell_macos')).toBe(false)
    expect(isSubagentWorkspaceReadTool('run_verification_command')).toBe(false)
    expect(isSubagentWorkspaceReadTool('read_file')).toBe(true)
    expect(isSubagentHistoryTool('search_agent_histories')).toBe(true)
    expect(isSubagentWorkspaceReadTool('search_agent_histories')).toBe(true)
    expect(isSubagentHistoryTool('write_file')).toBe(false)
    expect(subagentProfileAllowsHistory('workspace_verify')).toBe(true)
    expect(subagentProfileAllowsHistory('write_all' as SubagentToolProfile)).toBe(false)
  })
})
