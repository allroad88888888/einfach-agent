// 真实 prompt 行为 A/B —— 需要 DEEPSEEK_BEHAVIOR_AB=1 + DEEPSEEK_API_KEY 才会执行。
// 这里【不】设发布门槛：本套件量的是「机制把行为率推动了多少」，方向与幅度要人看，
// 断言只守住「样本齐、没有传输故障、arm A 一次提醒都没被注入」这些结构性前提。

import { describe, expect, it } from 'vitest'
import {
  formatDeepSeekBehaviorSummary,
  summarizeDeepSeekBehaviorResults,
  writeDeepSeekBehaviorResults,
} from './behavior-report'
import { runDeepSeekBehaviorSuite } from './behavior-runner'
import {
  behaviorArmsForTask,
  resolveBehaviorRepeat,
  selectBehaviorTasks,
} from './behavior-suite'

const LIVE_ENABLED = process.env.DEEPSEEK_BEHAVIOR_AB === '1'

describe.skipIf(!LIVE_ENABLED)('DeepSeek live prompt 行为 A/B', () => {
  it('跑完 arm × task × repeat 并落 JSONL 证据', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required when DEEPSEEK_BEHAVIOR_AB=1.')
    }
    const repeats = resolveBehaviorRepeat(process.env.DEEPSEEK_BEHAVIOR_REPEAT)
    // 默认全量；`DEEPSEEK_BEHAVIOR_TASKS=B04` 之类只跑一个组（蓝图门禁要 n ≥ 20，
    // 没必要顺带把 B01/B02 也重跑一遍）。
    const tasks = selectBehaviorTasks(process.env.DEEPSEEK_BEHAVIOR_TASKS)
    const results = await runDeepSeekBehaviorSuite({
      apiKey,
      model: process.env.DEEPSEEK_BEHAVIOR_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      repeats,
      tasks,
      caseTimeoutMs: Number(process.env.DEEPSEEK_BEHAVIOR_CASE_TIMEOUT_MS ?? 180_000),
    })
    const resultPath = await writeDeepSeekBehaviorResults(
      results,
      process.env.DEEPSEEK_BEHAVIOR_RESULT_PATH,
    )
    const summary = summarizeDeepSeekBehaviorResults(results, tasks)
    console.info(`DeepSeek behavior A/B evidence: ${resultPath}`)
    console.info(formatDeepSeekBehaviorSummary(summary))
    console.info(`DeepSeek behavior A/B summary: ${JSON.stringify(summary)}`)

    // 每个任务跑自己那一组 arm（B01/B02 两个、B04 两个、B05 一个），所以不是简单相乘。
    const expectedRuns = tasks.reduce(
      (sum, task) => sum + behaviorArmsForTask(task).length * repeats,
      0,
    )
    expect(results).toHaveLength(expectedRuns)
    expect(
      results.filter((result) => result.error !== null),
      `传输故障不是行为结果；查看 JSONL 证据：${resultPath}`,
    ).toEqual([])
    expect(summary.tool_protocol_errors).toBe(0)
    // arm baseline 必须是干净基线：一次连败提醒都不该被注入（只有声明了它的任务有这一格）。
    for (const task of summary.tasks) {
      const baseline = task.arms.baseline
      if (baseline) expect(baseline.failure_notice_injections, task.task_id).toBe(0)
    }
  }, 60 * 60 * 1_000)
})
