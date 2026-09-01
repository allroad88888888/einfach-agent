// @einfach-agent/tools 的聚合完整性测试（TSPLIT TS2）。
// ---------------------------------------------------------------------------
// 登记反转后，「标准工具集是否装齐、名字是否正确」这件事的归属从 core 移到这里 ——
// core 只提供空注册表 + 抽象；本 meta 包负责把 7 域 36 工具聚合成 registerStandardTools。
// 故这份断言留在 meta（而非 agent-core），agent-core 的测试对具体工具保持无知。

import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { registerStandardTools } from './index'

// 7 域 36 个标准工具的权威清单（顺序 = 注册顺序：shell → interaction → vision → fs → planning → skills → agents）。
const STANDARD_TOOLS = [
  // shell（6）
  'shell_macos', 'shell_linux', 'shell_powershell', 'run_task', 'run_verification_command',
  'git_diff_review',
  // interaction（3）
  'ask_user_question', 'browser_action', 'save_file',
  // vision（1）
  'view_image',
  // fs（11）
  'read_file', 'list_files', 'search_files', 'rg_search', 'apply_patch', 'write_file',
  'delete_path', 'copy_path', 'move_path', 'revert_workspace_change', 'find_test_lint_commands',
  // planning（5）
  'get_plan', 'create_plan', 'update_plan', 'execute_plan', 'submit_stage_result',
  // skills（2）
  'skill_search', 'skill_read',
  // agents（8）
  'delegate_agent', 'observe_agent', 'join_agent', 'cancel_agent',
  'list_agent_histories', 'list_agent_history_items', 'read_agent_history_item',
  'search_agent_histories',
] as const

const REPLAY_UNSAFE_STANDARD_TOOLS = [
  'shell_macos', 'shell_linux', 'shell_powershell', 'run_task', 'run_verification_command',
  'save_file', 'apply_patch', 'write_file', 'delete_path', 'copy_path', 'move_path',
  'revert_workspace_change', 'delegate_agent', 'view_image',
] as const

describe('@einfach-agent/tools —— 标准工具集聚合（TSPLIT TS2）', () => {
  it('registerStandardTools 恰好装齐 36 个工具', () => {
    const reg = createToolRegistry()
    registerStandardTools(reg)
    expect(reg.list().length).toBe(36)
    expect(STANDARD_TOOLS.length).toBe(36)
  })

  it('七域每个工具都按 name 就位', () => {
    const reg = createToolRegistry()
    registerStandardTools(reg)
    for (const name of STANDARD_TOOLS) {
      expect(reg.has(name)).toBe(true)
    }
  })

  it('幂等：重复 registerStandardTools 不新增（同名覆盖）', () => {
    const reg = createToolRegistry()
    registerStandardTools(reg)
    registerStandardTools(reg)
    expect(reg.list().length).toBe(36)
  })

  it('副作用或高代价工具通过 replayUnsafe 元数据登记', () => {
    const reg = createToolRegistry()
    registerStandardTools(reg)
    expect([...reg.replayUnsafeToolNames()].sort()).toEqual([...REPLAY_UNSAFE_STANDARD_TOOLS].sort())
  })
})
