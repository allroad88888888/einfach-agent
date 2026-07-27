// prompt 行为 A/B 汇总的离线用例：只喂手工构造的结果记录，不碰网络。

import { describe, expect, it } from 'vitest'
import {
  formatDeepSeekBehaviorSummary,
  summarizeDeepSeekBehaviorResults,
} from './behavior-report'
import type { DeepSeekBehaviorAbResult } from './behavior-runner'
import type { DeepSeekBehaviorArmId } from './behavior-suite'

interface ResultOverrides {
  taskId: string
  arm: DeepSeekBehaviorArmId
  criteria: Record<string, boolean>
  turns?: number
  toolCalls?: number
  finalAnswer?: boolean
  notices?: number
  protocolErrors?: number
  transportError?: boolean
  /** 工具名序列：组级 skill_read 平均次数就是从它数出来的。 */
  trace?: string[]
}

function result(overrides: ResultOverrides): DeepSeekBehaviorAbResult {
  return {
    schema_version: 'deepseek-behavior-ab/v1',
    suite_version: 'test',
    run_id: 'run',
    repeat: 0,
    order_index: 0,
    task_id: overrides.taskId,
    arm: overrides.arm,
    arm_flags: {
      self_check_clauses: overrides.arm === 'self_check',
      failure_streak_notice: overrides.arm === 'self_check',
    },
    model: 'deepseek-v4-pro',
    response_model: 'deepseek-v4-pro',
    profile: { thinking: false, stream: false, max_tokens: 1_024, temperature: 1 },
    criteria: overrides.criteria,
    metrics: {
      turns: overrides.turns ?? 4,
      tool_calls: overrides.toolCalls ?? 3,
      tool_failures: 2,
      failure_notice_injections: overrides.notices ?? 0,
      final_answer: overrides.finalAnswer ?? true,
      final_json: true,
    },
    timing: { wall_ms: 10 },
    requests: {
      model_calls: overrides.turns ?? 4,
      http_requests: overrides.turns ?? 4,
      http_statuses: [200],
      finish_reasons: ['stop'],
      retry_count: 0,
      retry_reasons: [],
    },
    tools: {
      calls: overrides.toolCalls ?? 3,
      successes: 1,
      failures: 2,
      protocol_errors: overrides.protocolErrors ?? 0,
      trace: overrides.trace ?? [],
    },
    tokens: {
      input: 100,
      output: 20,
      total: 120,
      cache_hit: 40,
      cache_miss: 60,
      cache_miss_source: 'provider',
    },
    output_sha256: 'a'.repeat(64),
    error: overrides.transportError
      ? { kind: 'transport', name: 'TypeError', message: 'network down' }
      : null,
  }
}

function b01(
  arm: DeepSeekBehaviorArmId,
  criteria: {
    retry_identical: boolean
    adapted: boolean
    completed: boolean
    persisted_after_failure: boolean
  },
  extra: Partial<ResultOverrides> = {},
): DeepSeekBehaviorAbResult {
  return result({ taskId: 'B01', arm, criteria, ...extra })
}

function b02(
  arm: DeepSeekBehaviorArmId,
  criteria: { parseable: boolean; honest: boolean; fabricated: boolean },
  extra: Partial<ResultOverrides> = {},
): DeepSeekBehaviorAbResult {
  return result({ taskId: 'B02', arm, criteria, ...extra })
}

function b04(
  taskId: 'B04-1' | 'B04-2' | 'B04-3' | 'B04-4',
  arm: DeepSeekBehaviorArmId,
  // miss 类 case 没有 marker_used 这一格 —— 组级聚合要按 case 分别算分母。
  criteria: Record<string, boolean>,
  extra: Partial<ResultOverrides> = {},
): DeepSeekBehaviorAbResult {
  return result({ taskId, arm, criteria, ...extra })
}

function b05(
  criteria: { l2_read: boolean; l3_read: boolean; marker_used: boolean },
  extra: Partial<ResultOverrides> = {},
): DeepSeekBehaviorAbResult {
  return result({ taskId: 'B05', arm: 'manifest', criteria, ...extra })
}

describe('行为 A/B 汇总', () => {
  it('按 arm 聚合判据率、平均轮数与差值，每格都带 n', () => {
    const results = [
      // baseline：4 次里 3 次原样重试、1 次改法且完成；4 次里只有 1 次失败后仍试过。
      b01('baseline', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: false }, { turns: 4 }),
      b01('baseline', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: false }, { turns: 4 }),
      b01('baseline', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: false }, { turns: 4 }),
      b01('baseline', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { turns: 4 }),
      // self_check：4 次里 1 次原样重试、3 次改法，2 次完成；4 次里 3 次失败后仍试过。
      b01('self_check', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: true }, { turns: 5, notices: 1 }),
      b01('self_check', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { turns: 5, notices: 1 }),
      b01('self_check', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { turns: 5, notices: 1 }),
      b01('self_check', { retry_identical: false, adapted: true, completed: false, persisted_after_failure: false }, { turns: 5, notices: 2 }),
    ]

    const summary = summarizeDeepSeekBehaviorResults(results)
    const b01Summary = summary.tasks.find((task) => task.task_id === 'B01')!

    expect(summary.runs).toBe(8)
    expect(summary.transport_errors).toBe(0)
    expect(b01Summary.arm_ids).toEqual(['baseline', 'self_check'])
    expect(b01Summary.reference_arm).toBe('baseline')
    expect(b01Summary.treatment_arm).toBe('self_check')
    expect(b01Summary.group).toBeNull()
    expect(b01Summary.arms.baseline!.criteria).toEqual({
      retry_identical: { n: 4, count: 3, rate: 0.75 },
      adapted: { n: 4, count: 1, rate: 0.25 },
      completed: { n: 4, count: 1, rate: 0.25 },
      persisted_after_failure: { n: 4, count: 1, rate: 0.25 },
    })
    expect(b01Summary.arms.self_check!.criteria).toEqual({
      retry_identical: { n: 4, count: 1, rate: 0.25 },
      adapted: { n: 4, count: 3, rate: 0.75 },
      completed: { n: 4, count: 2, rate: 0.5 },
      persisted_after_failure: { n: 4, count: 3, rate: 0.75 },
    })
    expect(b01Summary.deltas).toEqual([
      { id: 'retry_identical', desirable: false, reference_rate: 0.75, treatment_rate: 0.25, delta: -0.5 },
      { id: 'adapted', desirable: true, reference_rate: 0.25, treatment_rate: 0.75, delta: 0.5 },
      { id: 'completed', desirable: true, reference_rate: 0.25, treatment_rate: 0.5, delta: 0.25 },
      { id: 'persisted_after_failure', desirable: true, reference_rate: 0.25, treatment_rate: 0.75, delta: 0.5 },
    ])
    expect(b01Summary.arms.baseline!.average_turns).toBe(4)
    expect(b01Summary.arms.self_check!.average_turns).toBe(5)
    expect(b01Summary.average_turns_delta).toBe(1)
    expect(b01Summary.arms.baseline!.failure_notice_injections).toBe(0)
    expect(b01Summary.arms.self_check!.failure_notice_injections).toBe(5)
  })

  it('传输故障退出分母但仍计入 runs；「做不完」留在分母里', () => {
    const results = [
      b02('baseline', { parseable: true, honest: false, fabricated: true }),
      b02('baseline', { parseable: false, honest: false, fabricated: false }, { finalAnswer: false }),
      b02('baseline', { parseable: false, honest: false, fabricated: false }, { transportError: true }),
      b02('self_check', { parseable: true, honest: true, fabricated: false }),
      b02('self_check', { parseable: true, honest: true, fabricated: false }),
    ]

    const summary = summarizeDeepSeekBehaviorResults(results)
    const b02Summary = summary.tasks.find((task) => task.task_id === 'B02')!

    expect(summary.runs).toBe(5)
    expect(summary.transport_errors).toBe(1)
    expect(b02Summary.arms.baseline).toMatchObject({
      runs: 3,
      transport_errors: 1,
      n: 2,
      final_answer_count: 1,
      final_answer_rate: 0.5,
    })
    expect(b02Summary.arms.baseline!.criteria.honest).toEqual({ n: 2, count: 0, rate: 0 })
    expect(b02Summary.arms.baseline!.criteria.fabricated).toEqual({ n: 2, count: 1, rate: 0.5 })
    expect(b02Summary.arms.self_check!.criteria.honest).toEqual({ n: 2, count: 2, rate: 1 })
    expect(b02Summary.deltas.find((delta) => delta.id === 'honest')?.delta).toBe(1)
    expect(b02Summary.deltas.find((delta) => delta.id === 'fabricated')?.delta).toBe(-0.5)
  })

  it('没有样本时给 null 而不是 0，也不产生 NaN', () => {
    const summary = summarizeDeepSeekBehaviorResults([])
    expect(summary.runs).toBe(0)
    for (const task of summary.tasks) {
      expect(task.arm_ids.length).toBeGreaterThan(0)
      for (const armId of task.arm_ids) {
        const arm = task.arms[armId]!
        expect(arm.n).toBe(0)
        expect(arm.average_turns).toBeNull()
        expect(arm.final_answer_rate).toBeNull()
        expect(Object.values(arm.criteria).every((cell) => cell.rate === null)).toBe(true)
      }
      expect(task.deltas.every((delta) => delta.delta === null)).toBe(true)
    }
    for (const group of summary.groups) {
      for (const armId of group.arm_ids) {
        const arm = group.arms[armId]!
        expect(arm.n).toBe(0)
        expect(arm.average_turns).toBeNull()
        expect(arm.average_skill_read_calls).toBeNull()
      }
    }
    expect(JSON.stringify(summary)).not.toContain('NaN')
    expect(formatDeepSeekBehaviorSummary(summary)).toContain('n/a')
  })

  it('B04 组级聚合：判据分母按「声明了该判据的 case」单独算，差值 = manifest − prefilter', () => {
    // 每个 (case, arm) 各一次运行。prefilter 在语义 case 上必然读不到（名单为空），
    // manifest 能靠 description 自判读到 —— 这正是门禁要看的那个差值。
    const results = [
      b04('B04-1', 'prefilter', { target_read: true, false_read: false, marker_used: true }, { turns: 2, trace: ['skill_read'] }),
      b04('B04-2', 'prefilter', { target_read: false, false_read: false, marker_used: false }, { turns: 2 }),
      b04('B04-3', 'prefilter', { target_read: true, false_read: false }, { turns: 2 }),
      b04('B04-4', 'prefilter', { target_read: false, false_read: true }, { turns: 2, trace: ['skill_read'] }),
      b04('B04-1', 'manifest', { target_read: true, false_read: false, marker_used: true }, { turns: 3, trace: ['skill_read'] }),
      b04('B04-2', 'manifest', { target_read: true, false_read: false, marker_used: true }, { turns: 3, trace: ['skill_read'] }),
      b04('B04-3', 'manifest', { target_read: true, false_read: false }, { turns: 3 }),
      b04('B04-4', 'manifest', { target_read: false, false_read: true }, { turns: 3, trace: ['skill_read'] }),
    ]

    const summary = summarizeDeepSeekBehaviorResults(results)
    const group = summary.groups.find((entry) => entry.group === 'B04')!

    expect(group.task_ids).toEqual(['B04-1', 'B04-2', 'B04-3', 'B04-4'])
    expect(group.arm_ids).toEqual(['prefilter', 'manifest'])
    expect(group.reference_arm).toBe('prefilter')
    expect(group.treatment_arm).toBe('manifest')
    expect(group.arms.prefilter!.criteria).toEqual({
      target_read: { n: 4, count: 2, rate: 0.5 },
      false_read: { n: 4, count: 1, rate: 0.25 },
      // marker_used 只有两个 hit case 声明，分母就只有 2 —— miss case 不该被算成「没做到」。
      marker_used: { n: 2, count: 1, rate: 0.5 },
    })
    expect(group.arms.manifest!.criteria).toEqual({
      target_read: { n: 4, count: 3, rate: 0.75 },
      false_read: { n: 4, count: 1, rate: 0.25 },
      marker_used: { n: 2, count: 2, rate: 1 },
    })
    expect(group.deltas).toEqual([
      { id: 'target_read', desirable: true, reference_rate: 0.5, treatment_rate: 0.75, delta: 0.25 },
      { id: 'false_read', desirable: false, reference_rate: 0.25, treatment_rate: 0.25, delta: 0 },
      { id: 'marker_used', desirable: true, reference_rate: 0.5, treatment_rate: 1, delta: 0.5 },
    ])
    expect(group.arms.prefilter!.average_skill_read_calls).toBe(0.5)
    expect(group.arms.manifest!.average_skill_read_calls).toBe(0.75)
    expect(group.average_skill_read_calls_delta).toBe(0.25)
    expect(group.arms.prefilter!.average_turns).toBe(2)
    expect(group.arms.manifest!.average_turns).toBe(3)
    expect(group.average_turns_delta).toBe(1)
    // 逐 case 的表仍在，组表只是它们的合并视图。
    expect(summary.tasks.filter((task) => task.group === 'B04').map((task) => task.task_id))
      .toEqual(['B04-1', 'B04-2', 'B04-3', 'B04-4'])
    expect(summary.tasks.find((task) => task.task_id === 'B04-2')!.deltas)
      .toContainEqual({ id: 'target_read', desirable: true, reference_rate: 0, treatment_rate: 1, delta: 1 })
  })

  it('B04 组级：传输故障退出分母，但仍计入 runs', () => {
    const summary = summarizeDeepSeekBehaviorResults([
      b04('B04-1', 'manifest', { target_read: true, false_read: false, marker_used: true }, { trace: ['skill_read'] }),
      b04('B04-2', 'manifest', { target_read: false, false_read: false, marker_used: false }, { transportError: true }),
    ])
    const group = summary.groups.find((entry) => entry.group === 'B04')!

    expect(group.arms.manifest).toMatchObject({ runs: 2, transport_errors: 1, n: 1 })
    expect(group.arms.manifest!.criteria.target_read).toEqual({ n: 1, count: 1, rate: 1 })
    expect(group.arms.manifest!.criteria.marker_used).toEqual({ n: 1, count: 1, rate: 1 })
    expect(group.arms.manifest!.average_skill_read_calls).toBe(1)
  })

  it('B05 组级：只有一个 arm，没有对照就不编差值', () => {
    const summary = summarizeDeepSeekBehaviorResults([
      b05({ l2_read: true, l3_read: true, marker_used: true }, { turns: 3, trace: ['skill_read', 'skill_read'] }),
      b05({ l2_read: true, l3_read: true, marker_used: false }, { turns: 3, trace: ['skill_read', 'skill_read'] }),
      b05({ l2_read: true, l3_read: false, marker_used: false }, { turns: 2, trace: ['skill_read'] }),
      b05({ l2_read: false, l3_read: false, marker_used: false }, { turns: 1 }),
    ])
    const group = summary.groups.find((entry) => entry.group === 'B05')!

    expect(group.arm_ids).toEqual(['manifest'])
    expect(group.reference_arm).toBe('manifest')
    expect(group.treatment_arm).toBeNull()
    expect(group.arms.manifest!.criteria).toEqual({
      l2_read: { n: 4, count: 3, rate: 0.75 },
      l3_read: { n: 4, count: 2, rate: 0.5 },
      marker_used: { n: 4, count: 1, rate: 0.25 },
    })
    expect(group.arms.manifest!.average_turns).toBe(2.25)
    expect(group.arms.manifest!.average_skill_read_calls).toBe(1.25)
    expect(group.deltas.every((delta) => delta.treatment_rate === null && delta.delta === null))
      .toBe(true)
    expect(group.average_turns_delta).toBeNull()
    expect(group.average_skill_read_calls_delta).toBeNull()
  })

  it('汇总工具协议错误总数', () => {
    const summary = summarizeDeepSeekBehaviorResults([
      b01('baseline', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { protocolErrors: 2 }),
      b01('self_check', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { protocolErrors: 1 }),
    ])
    expect(summary.tool_protocol_errors).toBe(3)
  })
})

describe('行为 A/B 文本表', () => {
  it('每格都写出比率与 n，并给出差值和注入次数', () => {
    const text = formatDeepSeekBehaviorSummary(summarizeDeepSeekBehaviorResults([
      b01('baseline', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: false }),
      b01('baseline', { retry_identical: true, adapted: false, completed: false, persisted_after_failure: false }),
      b01('self_check', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { notices: 1 }),
      b01('self_check', { retry_identical: false, adapted: true, completed: true, persisted_after_failure: true }, { notices: 1 }),
    ]))

    expect(text).toContain('── B01')
    expect(text).toMatch(/retry_identical\s+越低越好\s+100\.0% \(2\/2\)\s+0\.0% \(0\/2\)\s+-100\.0pp/)
    expect(text).toMatch(/adapted\s+越高越好\s+0\.0% \(0\/2\)\s+100\.0% \(2\/2\)\s+\+100\.0pp/)
    expect(text).toMatch(/persisted_after_failure\s+越高越好\s+0\.0% \(0\/2\)\s+100\.0% \(2\/2\)\s+\+100\.0pp/)
    expect(text).toContain('连败提醒注入次数：baseline 0（应恒为 0）／self_check 2')
    // B02 这次没有任何样本，仍应出现在表里且写成 n/a (0/0)。
    expect(text).toContain('── B02')
    expect(text).toContain('n/a (0/0)')
  })

  it('skill 清单实验的表头用自己的 arm 名，并额外打一张组表', () => {
    const text = formatDeepSeekBehaviorSummary(summarizeDeepSeekBehaviorResults([
      b04('B04-1', 'prefilter', { target_read: true, false_read: false, marker_used: true }, { turns: 2, trace: ['skill_read'] }),
      b04('B04-2', 'prefilter', { target_read: false, false_read: false, marker_used: false }, { turns: 2 }),
      b04('B04-1', 'manifest', { target_read: true, false_read: false, marker_used: true }, { turns: 2, trace: ['skill_read'] }),
      b04('B04-2', 'manifest', { target_read: true, false_read: false, marker_used: true }, { turns: 2, trace: ['skill_read'] }),
      b05({ l2_read: true, l3_read: true, marker_used: true }, { turns: 3, trace: ['skill_read', 'skill_read'] }),
    ]))

    expect(text).toMatch(/── B04-2 hit-semantic[\s\S]*?判据\s+期望\s+prefilter\s+manifest\s+差值/)
    expect(text).toMatch(/target_read\s+越高越好\s+0\.0% \(0\/1\)\s+100\.0% \(1\/1\)\s+\+100\.0pp/)
    // 组表：4 个 case 合并，marker_used 的分母只数 hit 类 case。
    expect(text).toContain('── 组 B04')
    expect(text).toContain('case：B04-1、B04-2、B04-3、B04-4')
    expect(text).toMatch(/skill_read_calls\s+—\s+0\.50\s+1\.00\s+\+0\.50/)
    expect(text).toContain('── 组 B05')
    expect(text).toMatch(/l3_read\s+越高越好\s+100\.0% \(1\/1\)\s+n\/a/)
    // skill 清单实验没有连败提醒机制，不该打那一行噪音。
    expect(text.split('── 组 B04')[1]).not.toContain('连败提醒注入次数')
  })
})
