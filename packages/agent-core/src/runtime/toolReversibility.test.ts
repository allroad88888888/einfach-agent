import { describe, expect, it } from 'vitest'
import { DANGEROUS_TOOLS } from './dangerousTools'
import { classifyToolReversibility, isPureTool } from './toolReversibility'

describe('classifyToolReversibility', () => {
  it.each([
    'read_file',
    'list_files',
    'search_files',
    'rg_search',
    'get_plan',
    'skill_manifest',
    'skill_search',
    'skill_read',
    'observe_agent',
  ])('treats the read-only tool %s as pure', (name) => {
    expect(classifyToolReversibility(name)).toBe('pure')
    expect(isPureTool(name)).toBe(true)
  })

  it.each([
    // 有外部副作用
    'write_file',
    'apply_patch',
    'delete_path',
    'shell_macos',
    'run_task',
    // 刻意排除的近似项，理由见 toolReversibility.ts 的注释
    ['find_test_lint_commands 会调 runLowCostExtraction，重发要重复付费', 'find_test_lint_commands'],
    ['git_diff_review 只读但经 shell 执行', 'git_diff_review'],
    ['save_file 重发会重复落一份产物', 'save_file'],
    ['join_agent 改变后台执行节点状态', 'join_agent'],
    ['cancel_agent 同上', 'cancel_agent'],
    // 计划变更
    'create_plan',
    'submit_stage_result',
  ].map((entry) => (Array.isArray(entry) ? entry : ['', entry])) as [string, string][])(
    'treats %s%s as irreversible',
    (_reason, name) => {
      expect(classifyToolReversibility(name)).toBe('irreversible')
      expect(isPureTool(name)).toBe(false)
    },
  )

  it('fails closed for unknown names, so a typo in the pure list can only be over-strict', () => {
    expect(classifyToolReversibility('read_fil')).toBe('irreversible')
    expect(classifyToolReversibility('')).toBe('irreversible')
    expect(classifyToolReversibility('some_future_tool')).toBe('irreversible')
  })

  it('never trusts an externally declared tool to be repeatable', () => {
    // MCP 工具的副作用由外部服务决定，声明侧不可信 —— 这正是不把本判据做成注册期元数据的理由。
    expect(classifyToolReversibility('mcp__files__read')).toBe('irreversible')
    expect(classifyToolReversibility('mcp__anything')).toBe('irreversible')
  })

  it('keeps the two dimensions consistent: no dangerous tool may be pure', () => {
    // 风险与可重复性正交，但这一个方向必须成立：会改外部世界所以要确认的工具，
    // 绝不能同时被判为「中断后可以直接重发」。少了这条断言，往 PURE_TOOLS 里
    // 误加一个 write_file 不会有任何测试变红。
    for (const name of DANGEROUS_TOOLS) {
      expect(classifyToolReversibility(name)).toBe('irreversible')
    }
  })
})
