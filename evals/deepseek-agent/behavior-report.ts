// prompt 行为 A/B 的汇总 —— 按 (task, arm) 聚合判据率，给出 arm 之间的差值。
// ---------------------------------------------------------------------------
// 与 task-report 的区别：那套要判发布门槛（质量/成本/时延），这套只回答一个问题
// ——「换掉这一处 prompt 机制之后，模型的行为率变了多少」。所以这里没有 release gate，
// 也不算钱；每一格都带自己的 n，避免拿 0/0 的比率互相比较。
//
// 分母口径：n 只数 error === null 的运行。传输故障不是行为结果，不该稀释判据率；
// 而「模型没完成任务」在 runner 里【不算】错误（final_answer=false，判据自然为 false），
// 所以它仍然留在分母里 —— 否则「做不完」会被悄悄洗成「没被统计」。
//
// arm 不再写死成 baseline/self_check：每个任务跑自己声明的一组 arm（B04 是
// prefilter/manifest，B05 只有 manifest），差值一律是「第二个 arm − 第一个 arm」，
// 即 treatment − reference。声明了 group 的任务再额外合并出一张组级表 —— B04 的门禁
// （manifest 相对 prefilter 的 target_read 差距 ≤ 5pp）看的就是组级数字，
// 单个 case 的 n 太小。

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  behaviorArmsForTask,
  DEEPSEEK_BEHAVIOR_GROUPS,
  DEEPSEEK_BEHAVIOR_RESULT_SCHEMA,
  DEEPSEEK_BEHAVIOR_TASKS,
  SKILL_READ_TOOL_NAME,
  type DeepSeekBehaviorArmId,
  type DeepSeekBehaviorTaskSpec,
} from './behavior-suite'
import type { DeepSeekBehaviorAbResult } from './behavior-runner'

export interface DeepSeekBehaviorCell {
  /** 该判据的有效样本数（= 非传输故障的运行数）。 */
  n: number
  count: number
  /** count / n；n 为 0 时是 null，不伪造 0。 */
  rate: number | null
}

export interface DeepSeekBehaviorArmSummary {
  runs: number
  transport_errors: number
  /** 有效样本数：所有判据共用同一个分母。 */
  n: number
  criteria: Record<string, DeepSeekBehaviorCell>
  average_turns: number | null
  average_tool_calls: number | null
  final_answer_count: number
  final_answer_rate: number | null
  failure_notice_injections: number
}

export interface DeepSeekBehaviorCriterionDelta {
  id: string
  /** true = 该判据越高越好。 */
  desirable: boolean
  /** 参照 arm（arm 列表的第一个）的比率。 */
  reference_rate: number | null
  /** 处理 arm（arm 列表的第二个）的比率；单 arm 任务为 null。 */
  treatment_rate: number | null
  /** treatment − reference；任一侧无样本时为 null。 */
  delta: number | null
}

export interface DeepSeekBehaviorTaskSummary {
  task_id: string
  title: string
  /** 组归属（B04 / B05）；没声明组的任务为 null。 */
  group: string | null
  /** 该任务实际跑的 arm，顺序即声明顺序（第一个是参照）。 */
  arm_ids: DeepSeekBehaviorArmId[]
  reference_arm: DeepSeekBehaviorArmId | null
  treatment_arm: DeepSeekBehaviorArmId | null
  arms: Partial<Record<DeepSeekBehaviorArmId, DeepSeekBehaviorArmSummary>>
  /** 每个判据一行（单 arm 任务的 treatment/delta 为 null，行仍在——表格靠它排版）。 */
  deltas: DeepSeekBehaviorCriterionDelta[]
  average_turns_delta: number | null
}

/** 组级 arm 聚合：把同组各 case 的运行合到一起，判据分母按「声明了该判据的 case」单独算。 */
export interface DeepSeekBehaviorGroupArmSummary {
  runs: number
  transport_errors: number
  n: number
  criteria: Record<string, DeepSeekBehaviorCell>
  average_turns: number | null
  /** 平均 skill_read 调用次数（从 tools.trace 的工具名数，含读失败的尝试）。 */
  average_skill_read_calls: number | null
}

export interface DeepSeekBehaviorGroupSummary {
  group: string
  title: string
  task_ids: string[]
  arm_ids: DeepSeekBehaviorArmId[]
  reference_arm: DeepSeekBehaviorArmId | null
  treatment_arm: DeepSeekBehaviorArmId | null
  arms: Partial<Record<DeepSeekBehaviorArmId, DeepSeekBehaviorGroupArmSummary>>
  deltas: DeepSeekBehaviorCriterionDelta[]
  average_turns_delta: number | null
  average_skill_read_calls_delta: number | null
}

export interface DeepSeekBehaviorSummary {
  schema_version: typeof DEEPSEEK_BEHAVIOR_RESULT_SCHEMA
  runs: number
  transport_errors: number
  tool_protocol_errors: number
  tasks: DeepSeekBehaviorTaskSummary[]
  /** 声明了 group 的任务合并出的组级表；没有这类任务时为空数组。 */
  groups: DeepSeekBehaviorGroupSummary[]
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function ratio(count: number, total: number): number | null {
  return total > 0 ? round(count / total) : null
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2)
}

function armSummary(
  task: DeepSeekBehaviorTaskSpec,
  results: DeepSeekBehaviorAbResult[],
): DeepSeekBehaviorArmSummary {
  const valid = results.filter((result) => result.error === null)
  const finalAnswers = valid.filter((result) => result.metrics.final_answer).length
  const criteria: Record<string, DeepSeekBehaviorCell> = {}
  for (const criterion of task.criteria) {
    const count = valid.filter((result) => result.criteria[criterion.id] === true).length
    criteria[criterion.id] = { n: valid.length, count, rate: ratio(count, valid.length) }
  }
  return {
    runs: results.length,
    transport_errors: results.length - valid.length,
    n: valid.length,
    criteria,
    average_turns: average(valid.map((result) => result.metrics.turns)),
    average_tool_calls: average(valid.map((result) => result.metrics.tool_calls)),
    final_answer_count: finalAnswers,
    final_answer_rate: ratio(finalAnswers, valid.length),
    failure_notice_injections: results.reduce(
      (sum, result) => sum + result.metrics.failure_notice_injections,
      0,
    ),
  }
}

function subtract(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : round(left - right, 4)
}

function skillReadCalls(result: DeepSeekBehaviorAbResult): number {
  return result.tools.trace.filter((name) => name === SKILL_READ_TOOL_NAME).length
}

/**
 * 组级 arm 聚合。判据分母【不】共用：某个判据只有部分 case 声明（B04 的 marker_used 只在
 * 两个 hit case 上），它的 n 就只数那些 case 的运行 —— 否则 miss case 会被当成「没做到」
 * 白白拉低比率。
 */
function groupArmSummary(
  members: readonly DeepSeekBehaviorTaskSpec[],
  criterionIds: readonly string[],
  results: DeepSeekBehaviorAbResult[],
): DeepSeekBehaviorGroupArmSummary {
  const valid = results.filter((result) => result.error === null)
  const declaredBy = new Map(
    members.map((task) => [task.id, new Set(task.criteria.map((c) => c.id))] as const),
  )
  const criteria: Record<string, DeepSeekBehaviorCell> = {}
  for (const id of criterionIds) {
    const scoped = valid.filter((result) => declaredBy.get(result.task_id)?.has(id) === true)
    const count = scoped.filter((result) => result.criteria[id] === true).length
    criteria[id] = { n: scoped.length, count, rate: ratio(count, scoped.length) }
  }
  return {
    runs: results.length,
    transport_errors: results.length - valid.length,
    n: valid.length,
    criteria,
    average_turns: average(valid.map((result) => result.metrics.turns)),
    average_skill_read_calls: average(valid.map(skillReadCalls)),
  }
}

function criterionMeta(
  members: readonly DeepSeekBehaviorTaskSpec[],
): Array<{ id: string; desirable: boolean }> {
  const seen = new Map<string, boolean>()
  for (const task of members) {
    for (const criterion of task.criteria) {
      if (!seen.has(criterion.id)) seen.set(criterion.id, criterion.desirable)
    }
  }
  return [...seen].map(([id, desirable]) => ({ id, desirable }))
}

export function summarizeDeepSeekBehaviorResults(
  results: DeepSeekBehaviorAbResult[],
  tasks: readonly DeepSeekBehaviorTaskSpec[] = DEEPSEEK_BEHAVIOR_TASKS,
): DeepSeekBehaviorSummary {
  const taskSummaries: DeepSeekBehaviorTaskSummary[] = tasks.map((task) => {
    const forTask = results.filter((result) => result.task_id === task.id)
    const armIds = behaviorArmsForTask(task).map((arm) => arm.id)
    const arms: Partial<Record<DeepSeekBehaviorArmId, DeepSeekBehaviorArmSummary>> = {}
    for (const armId of armIds) {
      arms[armId] = armSummary(task, forTask.filter((result) => result.arm === armId))
    }
    const referenceArm = armIds[0] ?? null
    const treatmentArm = armIds[1] ?? null
    const reference = referenceArm === null ? undefined : arms[referenceArm]
    const treatment = treatmentArm === null ? undefined : arms[treatmentArm]
    return {
      task_id: task.id,
      title: task.title,
      group: task.group ?? null,
      arm_ids: armIds,
      reference_arm: referenceArm,
      treatment_arm: treatmentArm,
      arms,
      deltas: task.criteria.map((criterion) => ({
        id: criterion.id,
        desirable: criterion.desirable,
        reference_rate: reference?.criteria[criterion.id]?.rate ?? null,
        treatment_rate: treatment?.criteria[criterion.id]?.rate ?? null,
        delta: subtract(
          treatment?.criteria[criterion.id]?.rate ?? null,
          reference?.criteria[criterion.id]?.rate ?? null,
        ),
      })),
      average_turns_delta: subtract(
        treatment?.average_turns ?? null,
        reference?.average_turns ?? null,
      ),
    }
  })

  const groupIds = [...new Set(tasks.map((task) => task.group).filter(
    (group): group is string => group !== undefined,
  ))]
  const groups: DeepSeekBehaviorGroupSummary[] = groupIds.map((groupId) => {
    const members = tasks.filter((task) => task.group === groupId)
    const memberIds = new Set(members.map((task) => task.id))
    const forGroup = results.filter((result) => memberIds.has(result.task_id))
    const armIds = [...new Set(members.flatMap((task) => behaviorArmsForTask(task).map((a) => a.id)))]
    const meta = criterionMeta(members)
    const arms: Partial<Record<DeepSeekBehaviorArmId, DeepSeekBehaviorGroupArmSummary>> = {}
    for (const armId of armIds) {
      arms[armId] = groupArmSummary(
        members,
        meta.map((entry) => entry.id),
        forGroup.filter((result) => result.arm === armId),
      )
    }
    const referenceArm = armIds[0] ?? null
    const treatmentArm = armIds[1] ?? null
    const reference = referenceArm === null ? undefined : arms[referenceArm]
    const treatment = treatmentArm === null ? undefined : arms[treatmentArm]
    return {
      group: groupId,
      title: DEEPSEEK_BEHAVIOR_GROUPS.find((entry) => entry.id === groupId)?.title ?? groupId,
      task_ids: members.map((task) => task.id),
      arm_ids: armIds,
      reference_arm: referenceArm,
      treatment_arm: treatmentArm,
      arms,
      deltas: meta.map((entry) => ({
        id: entry.id,
        desirable: entry.desirable,
        reference_rate: reference?.criteria[entry.id]?.rate ?? null,
        treatment_rate: treatment?.criteria[entry.id]?.rate ?? null,
        delta: subtract(
          treatment?.criteria[entry.id]?.rate ?? null,
          reference?.criteria[entry.id]?.rate ?? null,
        ),
      })),
      average_turns_delta: subtract(
        treatment?.average_turns ?? null,
        reference?.average_turns ?? null,
      ),
      average_skill_read_calls_delta: subtract(
        treatment?.average_skill_read_calls ?? null,
        reference?.average_skill_read_calls ?? null,
      ),
    }
  })

  return {
    schema_version: DEEPSEEK_BEHAVIOR_RESULT_SCHEMA,
    runs: results.length,
    transport_errors: results.filter((result) => result.error !== null).length,
    tool_protocol_errors: results.reduce(
      (sum, result) => sum + result.tools.protocol_errors,
      0,
    ),
    tasks: taskSummaries,
    groups,
  }
}

function formatRate(cell: DeepSeekBehaviorCell | undefined): string {
  if (!cell || cell.rate === null) return `n/a (0/${cell?.n ?? 0})`
  return `${(cell.rate * 100).toFixed(1)}% (${cell.count}/${cell.n})`
}

function formatDelta(value: number | null, digits = 1, suffix = 'pp'): string {
  if (value === null) return 'n/a'
  const scaled = suffix === 'pp' ? value * 100 : value
  const sign = scaled > 0 ? '+' : ''
  return `${sign}${scaled.toFixed(digits)}${suffix}`
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2)
}

// CJK 与全角标点按两个终端列宽算（用码点转义写，避免源码里出现宽度可疑的字面量），
// 否则表格在等宽终端里会整列错位。
const WIDE_CHAR = /[\u2e80-\u9fff\uff00-\uff60]/

function padEnd(text: string, width: number): string {
  const displayWidth = [...text].reduce(
    (sum, char) => sum + (WIDE_CHAR.test(char) ? 2 : 1),
    0,
  )
  return text + ' '.repeat(Math.max(1, width - displayWidth))
}

const LABEL_WIDTH = 24
const EXPECT_WIDTH = 10
const ARM_WIDTH = 18

function headerRow(armIds: readonly string[]): string {
  return padEnd('判据', LABEL_WIDTH)
    + padEnd('期望', EXPECT_WIDTH)
    + armIds.map((armId) => padEnd(armId, ARM_WIDTH)).join('')
    + '差值'
}

function row(
  label: string,
  expectation: string,
  cells: readonly string[],
  tail: string,
): string {
  return padEnd(label, LABEL_WIDTH)
    + padEnd(expectation, EXPECT_WIDTH)
    + cells.map((cell) => padEnd(cell, ARM_WIDTH)).join('')
    + tail
}

/** stdout 文本对比表；结构化数据仍以 summarizeDeepSeekBehaviorResults 的返回值为准。 */
export function formatDeepSeekBehaviorSummary(summary: DeepSeekBehaviorSummary): string {
  const lines: string[] = [
    'DeepSeek prompt 行为 A/B',
    `总运行 ${summary.runs} 次；传输故障 ${summary.transport_errors} 次；`
      + `工具协议错误 ${summary.tool_protocol_errors} 次。`,
    'arm baseline = 无自查条款 + 无连败提醒；arm self_check = 两条机制全开；',
    'arm prefilter = 只给关键词命中的 skill 名单（现状）；arm manifest = 全量 skill 清单进 system 首部。',
    '差值一律 = 第二个 arm − 第一个 arm（treatment − reference）。',
  ]

  for (const task of summary.tasks) {
    const arms = task.arm_ids.map((armId) => task.arms[armId])
    lines.push('', `── ${task.task_id} ${task.title}`, headerRow(task.arm_ids))
    for (const delta of task.deltas) {
      lines.push(row(
        delta.id,
        delta.desirable ? '越高越好' : '越低越好',
        arms.map((arm) => formatRate(arm?.criteria[delta.id])),
        formatDelta(delta.delta),
      ))
    }
    lines.push(row(
      'average_turns',
      '—',
      arms.map((arm) => formatNumber(arm?.average_turns ?? null)),
      formatDelta(task.average_turns_delta, 2, ''),
    ))
    lines.push(row(
      'final_answer',
      '越高越好',
      arms.map((arm) => formatRate(arm && {
        n: arm.n,
        count: arm.final_answer_count,
        rate: arm.final_answer_rate,
      })),
      formatDelta(subtract(
        arms[1]?.final_answer_rate ?? null,
        arms[0]?.final_answer_rate ?? null,
      )),
    ))
    // 连败提醒只属于 B01/B02 的那组 arm；skill 清单实验没有这条机制，不打印噪音行。
    if (task.arm_ids.includes('baseline') && task.arm_ids.includes('self_check')) {
      lines.push(
        `连败提醒注入次数：baseline ${task.arms.baseline?.failure_notice_injections ?? 0}`
        + `（应恒为 0）／self_check ${task.arms.self_check?.failure_notice_injections ?? 0}`,
      )
    }
  }

  for (const group of summary.groups) {
    const arms = group.arm_ids.map((armId) => group.arms[armId])
    lines.push(
      '',
      `── 组 ${group.group} ${group.title}`,
      `case：${group.task_ids.join('、')}`,
      headerRow(group.arm_ids),
    )
    for (const delta of group.deltas) {
      lines.push(row(
        delta.id,
        delta.desirable ? '越高越好' : '越低越好',
        arms.map((arm) => formatRate(arm?.criteria[delta.id])),
        formatDelta(delta.delta),
      ))
    }
    lines.push(row(
      'average_turns',
      '—',
      arms.map((arm) => formatNumber(arm?.average_turns ?? null)),
      formatDelta(group.average_turns_delta, 2, ''),
    ))
    lines.push(row(
      'skill_read_calls',
      '—',
      arms.map((arm) => formatNumber(arm?.average_skill_read_calls ?? null)),
      formatDelta(group.average_skill_read_calls_delta, 2, ''),
    ))
  }
  return lines.join('\n')
}

export function defaultDeepSeekBehaviorResultPath(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(':', '-')
  return path.resolve(
    'evals/deepseek-agent/results',
    `${timestamp}.behavior-ab.jsonl`,
  )
}

export async function writeDeepSeekBehaviorResults(
  results: DeepSeekBehaviorAbResult[],
  resultPath = defaultDeepSeekBehaviorResultPath(),
): Promise<string> {
  const absolutePath = path.resolve(resultPath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  const jsonl = results.map((result) => JSON.stringify(result)).join('\n')
  await writeFile(absolutePath, `${jsonl}\n`, 'utf8')
  return absolutePath
}
