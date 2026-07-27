import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  defaultDeepSeekTaskResultPath,
  summarizeDeepSeekTaskResults,
  writeDeepSeekTaskResults,
} from './task-report'
import type { DeepSeekTaskAbResult } from './task-runner'
import {
  DEEPSEEK_TASK_RESULT_SCHEMA,
  DEEPSEEK_TASK_SUITE_VERSION,
  type DeepSeekTaskArm,
  type DeepSeekTaskScore,
} from './task-suite'

// 单条结果的成本（pico USD），由 task-cost 的价目表推出，测试里作为常量复核：
//   pro   = 8 * 3_625 + 12 * 435_000 + 5 * 870_000 = 9_599_000
//   flash = 8 * 2_800 + 12 * 140_000 + 5 * 280_000 = 3_102_400
const PRO_COST_PICO_USD = 9_599_000
const FLASH_COST_PICO_USD = 3_102_400

interface ResultOverrides {
  arm?: DeepSeekTaskArm
  task_id?: string
  replicate?: number
  model?: string
  response_model?: string | null
  shadow_tier?: 'pro' | 'flash'
  wall_ms?: number
  score?: Partial<DeepSeekTaskScore>
  tokens?: Partial<DeepSeekTaskAbResult['tokens']>
  tools?: Partial<DeepSeekTaskAbResult['tools']>
}

function result(overrides: ResultOverrides = {}): DeepSeekTaskAbResult {
  const arm: DeepSeekTaskArm = overrides.arm ?? 'pro'
  const model = overrides.model
    ?? (arm === 'pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash')
  return {
    schema_version: DEEPSEEK_TASK_RESULT_SCHEMA,
    suite_version: DEEPSEEK_TASK_SUITE_VERSION,
    run_id: 'run-report-test',
    replicate: overrides.replicate ?? 0,
    order_index: 0,
    task_id: overrides.task_id ?? 'T01',
    category: 'extraction',
    fixture_sha256: 'a'.repeat(64),
    prompt_version: 'prompt-test',
    scorer_version: 'scorer-test',
    route_features: {
      task_category: 'extraction',
      risk_level: 'low',
      cross_module: false,
      final_acceptance: false,
      requires_temporal_normalization: false,
    },
    shadow_route: { tier: overrides.shadow_tier ?? 'flash', reason: 'test' },
    arm,
    model,
    response_model:
      overrides.response_model === undefined ? model : overrides.response_model,
    profile: {
      thinking: false,
      reasoning_effort: null,
      stream: false,
      max_tokens: 1_024,
    },
    score: {
      earned: 100,
      max: 100,
      pass: true,
      hardFailures: [],
      components: {},
      ...overrides.score,
    },
    timing: { wall_ms: overrides.wall_ms ?? 10, ttft_ms: null },
    requests: {
      model_calls: 1,
      http_requests: 1,
      http_statuses: [200],
      finish_reasons: ['stop'],
      retry_count: 0,
      retry_reasons: [],
    },
    tools: {
      calls: 0,
      successes: 0,
      schema_errors: 0,
      unexpected: 0,
      duplicate_exact_calls: 0,
      recovery_turns: 0,
      trace: [],
      ...overrides.tools,
    },
    tokens: {
      input: 20,
      output: 5,
      total: 25,
      cache_hit: 8,
      cache_miss: 12,
      cache_miss_source: 'provider',
      ...overrides.tokens,
    },
    fallback_count: 0,
    output_sha256: null,
    error: null,
  }
}

function pair(
  taskId: string,
  shadowTier: 'pro' | 'flash',
  proOverrides: ResultOverrides = {},
  flashOverrides: ResultOverrides = {},
): DeepSeekTaskAbResult[] {
  return [
    result({
      shadow_tier: shadowTier,
      ...proOverrides,
      task_id: taskId,
      arm: 'pro',
    }),
    result({
      shadow_tier: shadowTier,
      ...flashOverrides,
      task_id: taskId,
      arm: 'flash',
    }),
  ]
}

describe('summarizeDeepSeekTaskResults baseline scoping', () => {
  it('uses the paired Pro subset — not the full Pro arm — as the cost baseline', () => {
    // 两个完整配对 + 一个只有 Pro 臂的落单结果。落单结果的 token 是配对结果的 10 倍，
    // 所以「全量 Pro 分母」和「配对 Pro 分母」会给出完全不同的节省比。
    const results: DeepSeekTaskAbResult[] = [
      ...pair('T01', 'flash'),
      ...pair('T03', 'pro'),
      result({
        task_id: 'T05',
        arm: 'pro',
        shadow_tier: 'pro',
        tokens: {
          input: 200,
          output: 50,
          total: 250,
          cache_hit: 80,
          cache_miss: 120,
          cache_miss_source: 'provider',
        },
      }),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.runs).toBe(5)
    expect(summary.pairs).toBe(2)

    // 配对子集：Pro 两条；影子策略 = T01 的 flash + T03 的 pro。
    const pairedProTotal = 2 * PRO_COST_PICO_USD
    const shadowTotal = FLASH_COST_PICO_USD + PRO_COST_PICO_USD
    expect(pairedProTotal).toBe(19_198_000)
    expect(shadowTotal).toBe(12_701_400)
    expect(summary.shadow_policy.total_cost_pico_usd).toBe(shadowTotal)
    expect(summary.shadow_policy.cost_per_pass_pico_usd).toBe(6_350_700)

    // 全量 Pro 臂（含落单结果）仍然被完整报告，但不能当基线用。
    expect(summary.arms.pro.runs).toBe(3)
    expect(summary.arms.pro.total_cost_pico_usd).toBe(115_188_000)
    expect(summary.arms.pro.cost_per_pass_pico_usd).toBe(38_396_000)

    // 正确口径（配对 Pro 分母）：1 - 12_701_400 / 19_198_000 = 0.3384
    expect(summary.shadow_policy.total_cost_savings_ratio).toBe(0.3384)
    expect(summary.shadow_policy.cost_per_pass_savings_ratio).toBe(0.3384)

    // 错误口径（全量 Pro 分母）会得到明显更乐观的数字，两者必须不同，
    // 否则这个回归测试锁不住任何东西。
    const allProTotalSavings =
      1 - shadowTotal / summary.arms.pro.total_cost_pico_usd!
    const allProCostPerPassSavings =
      1
      - summary.shadow_policy.cost_per_pass_pico_usd!
        / summary.arms.pro.cost_per_pass_pico_usd!
    expect(allProTotalSavings).toBeGreaterThan(0.88)
    expect(allProCostPerPassSavings).toBeGreaterThan(0.83)
    expect(summary.shadow_policy.total_cost_savings_ratio)
      .not.toBeCloseTo(allProTotalSavings, 3)
    expect(summary.shadow_policy.cost_per_pass_savings_ratio)
      .not.toBeCloseTo(allProCostPerPassSavings, 3)

    // passes_lost_vs_paired_pro 同样以配对 Pro 为基线：配对 Pro 通过 2，影子通过 2 → 0。
    // 用全量 Pro（通过 3）会算成 1。
    expect(summary.shadow_policy.passes_lost_vs_paired_pro).toBe(0)
    expect(summary.arms.pro.passes).toBe(3)

    expect(summary.release_gate.failure_reasons).toContain('incomplete_pairs')
    expect(summary.release_gate.failure_reasons).not.toContain('no_paired_results')
    expect(JSON.stringify(summary)).not.toContain('NaN')
  })

  it('uses the paired Pro subset as the p95 latency baseline', () => {
    // 落单的 Pro 结果有极大的 wall_ms：用全量 Pro 当基线时时延门槛会被抬到 11_000ms，
    // 影子的 30ms 会「通过」；用配对 Pro（p95 = 10ms，门槛 11ms）才会正确判定回归。
    const results: DeepSeekTaskAbResult[] = [
      ...pair('T01', 'flash', { wall_ms: 10 }, { wall_ms: 30 }),
      ...pair('T03', 'pro', { wall_ms: 10 }, { wall_ms: 10 }),
      result({ task_id: 'T05', arm: 'pro', shadow_tier: 'pro', wall_ms: 10_000 }),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.arms.pro.wall_p50_ms).toBe(10)
    expect(summary.arms.pro.wall_p95_ms).toBe(10_000)
    expect(summary.shadow_policy.wall_p50_ms).toBe(10)
    expect(summary.shadow_policy.wall_p95_ms).toBe(30)
    expect(summary.release_gate.checks.latency).toBe(false)
    expect(summary.release_gate.failure_reasons)
      .toContain('shadow_latency_regression')
  })
})

describe('summarizeDeepSeekTaskResults shadow policy selection', () => {
  it('picks the arm named by the Pro result shadow route tier', () => {
    // 两个配对里 pro/flash 两条记录的 shadow_route 故意写成相反的 tier，
    // 只有读取 Pro 结果的 tier 才能得到 [T01 flash, T03 pro]。
    const results: DeepSeekTaskAbResult[] = [
      ...pair(
        'T01',
        'flash',
        {},
        { shadow_tier: 'pro', score: { earned: 60, pass: true } },
      ),
      ...pair(
        'T03',
        'pro',
        {},
        { shadow_tier: 'flash', score: { earned: 20, pass: false } },
      ),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.shadow_policy.runs).toBe(2)
    // 取 flash(60) + pro(100)；如果按 flash 结果的 tier 取，会是 pro(100) + flash(20) = 60。
    expect(summary.shadow_policy.average_score).toBe(80)
    expect(summary.shadow_policy.passes).toBe(2)
    expect(summary.shadow_policy.total_cost_pico_usd)
      .toBe(FLASH_COST_PICO_USD + PRO_COST_PICO_USD)
    expect(summary.paired_pro_minus_flash_average_score).toBe(60)
  })
})

describe('summarizeDeepSeekTaskResults release gate', () => {
  it('passes the gate when every check holds', () => {
    const results: DeepSeekTaskAbResult[] = [
      ...pair('T01', 'flash'),
      ...pair('T09', 'flash'),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.release_gate.pass).toBe(true)
    expect(summary.release_gate.failure_reasons).toEqual([])
    expect(summary.release_gate.checks).toEqual({
      data_complete: true,
      quality: true,
      safety: true,
      latency: true,
      economics: true,
    })
    expect(summary.release_gate.thresholds).toEqual({
      max_pass_rate_drop: 0.01,
      max_p95_ratio: 1.10,
      max_tool_protocol_error_rate: 0.005,
      min_cost_per_pass_savings_ratio: 0.25,
      max_paired_regressions: 0,
    })
    expect(summary.shadow_policy).toMatchObject({
      runs: 2,
      passes: 2,
      pass_rate: 1,
      average_score: 100,
      total_cost_pico_usd: 2 * FLASH_COST_PICO_USD,
      cost_per_pass_pico_usd: FLASH_COST_PICO_USD,
      // 1 - 6_204_800 / 19_198_000
      total_cost_savings_ratio: 0.6768,
      cost_per_pass_savings_ratio: 0.6768,
      paired_regressions: 0,
      paired_improvements: 0,
      passes_lost_vs_paired_pro: 0,
    })
  })

  it('reports no_paired_results when an arm is missing entirely', () => {
    const summary = summarizeDeepSeekTaskResults([
      result({ task_id: 'T01', arm: 'pro' }),
      result({ task_id: 'T03', arm: 'pro' }),
    ])

    expect(summary.pairs).toBe(0)
    expect(summary.shadow_policy.runs).toBe(0)
    expect(summary.shadow_policy.total_cost_pico_usd).toBeNull()
    expect(summary.shadow_policy.total_cost_savings_ratio).toBeNull()
    expect(summary.shadow_policy.cost_per_pass_savings_ratio).toBeNull()
    expect(summary.shadow_policy.wall_p50_ms).toBeNull()
    expect(summary.arms.flash.runs).toBe(0)
    expect(summary.arms.flash.wall_p95_ms).toBeNull()
    expect(summary.release_gate.pass).toBe(false)
    // no_paired_results 与 incomplete_pairs 互斥（源码里是 else-if）。
    expect(summary.release_gate.failure_reasons).toEqual([
      'no_paired_results',
      'incomplete_cost_data',
      'shadow_pass_rate_regression',
      'shadow_tool_protocol_error',
      'shadow_latency_regression',
      'cost_per_pass_savings_below_target',
      'no_total_cost_savings',
    ])
    expect(JSON.stringify(summary)).not.toContain('NaN')
  })

  it('reports incomplete_cost_data when a shadow run has no exact cost', () => {
    const results: DeepSeekTaskAbResult[] = pair(
      'T01',
      'flash',
      {},
      {
        tokens: {
          cache_hit: null,
          cache_miss: null,
          cache_miss_source: 'unknown',
        },
      },
    )
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.arms.flash.cost_incomplete_runs).toBe(1)
    expect(summary.arms.flash.total_cost_pico_usd).toBeNull()
    expect(summary.shadow_policy.total_cost_pico_usd).toBeNull()
    expect(summary.shadow_policy.total_cost_savings_ratio).toBeNull()
    expect(summary.release_gate.checks.data_complete).toBe(false)
    expect(summary.release_gate.failure_reasons)
      .toContain('incomplete_cost_data')
    expect(JSON.stringify(summary)).not.toContain('NaN')
  })

  it('reports pass-rate and paired quality regressions when shadow loses a pass', () => {
    const results: DeepSeekTaskAbResult[] = [
      ...pair('T01', 'flash', {}, { score: { earned: 40, pass: false } }),
      ...pair('T09', 'flash'),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.shadow_policy.paired_regressions).toBe(1)
    expect(summary.shadow_policy.paired_improvements).toBe(0)
    expect(summary.shadow_policy.passes_lost_vs_paired_pro).toBe(1)
    expect(summary.release_gate.checks.quality).toBe(false)
    expect(summary.release_gate.failure_reasons)
      .toContain('shadow_pass_rate_regression')
    expect(summary.release_gate.failure_reasons)
      .toContain('paired_quality_regression')
  })

  it('counts paired regressions and improvements independently', () => {
    // 一个回归 + 一个改善 → 通过率持平，只应触发 paired_quality_regression。
    const results: DeepSeekTaskAbResult[] = [
      ...pair('T01', 'flash', {}, { score: { earned: 40, pass: false } }),
      ...pair(
        'T09',
        'flash',
        { score: { earned: 40, pass: false } },
        { score: { earned: 100, pass: true } },
      ),
    ]
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.shadow_policy.paired_regressions).toBe(1)
    expect(summary.shadow_policy.paired_improvements).toBe(1)
    expect(summary.shadow_policy.passes).toBe(1)
    expect(summary.shadow_policy.passes_lost_vs_paired_pro).toBe(0)
    expect(summary.release_gate.failure_reasons)
      .toEqual(['paired_quality_regression'])
  })

  it('only counts hard failures and tool protocol errors on the shadow arm', () => {
    // Pro 路由的配对里 flash 结果带硬失败和工具错误，影子取的是 pro，所以不该触发。
    const routedToPro = pair(
      'T03',
      'pro',
      {},
      {
        score: { hardFailures: ['change_C_secret'] },
        tools: { schema_errors: 1, unexpected: 1, duplicate_exact_calls: 1 },
      },
    )
    const proRoutedSummary = summarizeDeepSeekTaskResults(routedToPro)

    expect(proRoutedSummary.hard_failures).toBe(1)
    expect(proRoutedSummary.tool_schema_errors).toBe(1)
    expect(proRoutedSummary.unexpected_tools).toBe(1)
    expect(proRoutedSummary.duplicate_exact_tool_calls).toBe(1)
    expect(proRoutedSummary.release_gate.checks.safety).toBe(true)
    expect(proRoutedSummary.release_gate.failure_reasons)
      .not.toContain('shadow_hard_failure')
    expect(proRoutedSummary.release_gate.failure_reasons)
      .not.toContain('shadow_tool_protocol_error')

    // 同样的坏 flash 结果，一旦被影子策略选中就必须触发。
    const routedToFlash = pair(
      'T01',
      'flash',
      {},
      {
        score: { hardFailures: ['change_C_secret'] },
        tools: { schema_errors: 1 },
      },
    )
    const flashRoutedSummary = summarizeDeepSeekTaskResults(routedToFlash)

    expect(flashRoutedSummary.release_gate.checks.safety).toBe(false)
    expect(flashRoutedSummary.release_gate.failure_reasons)
      .toContain('shadow_hard_failure')
    expect(flashRoutedSummary.release_gate.failure_reasons)
      .toContain('shadow_tool_protocol_error')
  })

  it('reports cost_per_pass_savings_below_target while total savings stay positive', () => {
    // flash 侧 token 更多，成本只比 pro 低一点：0 < 节省比 < 0.25。
    const results: DeepSeekTaskAbResult[] = pair(
      'T01',
      'flash',
      {},
      {
        tokens: {
          input: 60,
          output: 15,
          total: 75,
          cache_hit: 25,
          cache_miss: 35,
          cache_miss_source: 'provider',
        },
      },
    )
    const summary = summarizeDeepSeekTaskResults(results)

    expect(summary.shadow_policy.total_cost_pico_usd).toBe(9_170_000)
    const savings = summary.shadow_policy.cost_per_pass_savings_ratio!
    expect(savings).toBeGreaterThan(0)
    expect(savings).toBeLessThan(0.25)
    expect(savings).toBe(0.044692)
    expect(summary.release_gate.checks.economics).toBe(false)
    expect(summary.release_gate.failure_reasons)
      .toEqual(['cost_per_pass_savings_below_target'])
  })

  it('reports no_total_cost_savings when the shadow policy keeps every task on Pro', () => {
    const summary = summarizeDeepSeekTaskResults(pair('T03', 'pro'))

    expect(summary.shadow_policy.total_cost_pico_usd).toBe(PRO_COST_PICO_USD)
    expect(summary.shadow_policy.total_cost_savings_ratio).toBe(0)
    expect(summary.shadow_policy.cost_per_pass_savings_ratio).toBe(0)
    expect(summary.release_gate.failure_reasons).toEqual([
      'cost_per_pass_savings_below_target',
      'no_total_cost_savings',
    ])
  })
})

describe('summarizeDeepSeekTaskResults arm summary', () => {
  it('computes p50/p95 wall time from the sorted arm samples', () => {
    const walls = [50, 10, 40, 20, 30]
    const summary = summarizeDeepSeekTaskResults(
      walls.map((wall, index) =>
        result({ task_id: `T${index}`, arm: 'pro', wall_ms: wall })),
    )

    expect(summary.arms.pro.runs).toBe(5)
    expect(summary.arms.pro.wall_p50_ms).toBe(30)
    expect(summary.arms.pro.wall_p95_ms).toBe(50)
    expect(summary.arms.flash.wall_p50_ms).toBeNull()
    expect(summary.arms.flash.wall_p95_ms).toBeNull()
  })

  it('degrades token and cost aggregates to null when a usage field is missing', () => {
    const missingInput = summarizeDeepSeekTaskResults([
      result({ task_id: 'T01', arm: 'pro' }),
      result({ task_id: 'T03', arm: 'pro', tokens: { input: null } }),
    ])

    expect(missingInput.arms.pro).toMatchObject({
      input_tokens: null,
      output_tokens: 10,
      total_tokens: 50,
      cache_hit_tokens: 16,
      cache_miss_tokens: 24,
      cache_hit_ratio: 0.4,
      cost_complete_runs: 1,
      cost_incomplete_runs: 1,
      total_cost_pico_usd: null,
      cost_per_pass_pico_usd: null,
      // 8_700_000 + 4_350_000（完整那条） + 25 * 870_000（只有 total 的那条）
      conservative_upper_cost_pico_usd: 34_800_000,
    })

    const missingTotal = summarizeDeepSeekTaskResults([
      result({ task_id: 'T01', arm: 'pro' }),
      result({ task_id: 'T03', arm: 'pro', tokens: { total: null } }),
    ])

    // total_tokens 是 `?? 0` 的降级，而不是 null。
    expect(missingTotal.arms.pro).toMatchObject({
      total_tokens: 0,
      input_tokens: 40,
      output_tokens: 10,
      total_cost_pico_usd: null,
    })

    const missingCacheSplit = summarizeDeepSeekTaskResults([
      result({
        task_id: 'T01',
        arm: 'pro',
        tokens: { cache_hit: null, cache_miss: null, cache_miss_source: 'unknown' },
      }),
    ])

    expect(missingCacheSplit.arms.pro).toMatchObject({
      cache_hit_tokens: null,
      cache_miss_tokens: null,
      cache_hit_ratio: null,
      total_cost_pico_usd: null,
    })
  })
})

describe('DeepSeek task result files', () => {
  let directory = ''

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'deepseek-task-report-'))
  })

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('builds a timestamped default path under the results directory', () => {
    const resultPath = defaultDeepSeekTaskResultPath(
      new Date('2026-07-24T09:30:00.000Z'),
    )

    expect(path.isAbsolute(resultPath)).toBe(true)
    expect(path.basename(resultPath))
      .toBe('2026-07-24T09-30-00.000Z.task-ab.jsonl')
    expect(resultPath.endsWith(
      path.join('evals', 'deepseek-agent', 'results', path.basename(resultPath)),
    )).toBe(true)
  })

  it('writes one JSON object per line with a trailing newline', async () => {
    const results = pair('T01', 'flash')
    const target = path.join(directory, 'nested', 'run.task-ab.jsonl')
    const written = await writeDeepSeekTaskResults(results, target)

    expect(written).toBe(path.resolve(target))
    const content = await readFile(written, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    const lines = content.slice(0, -1).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line) as DeepSeekTaskAbResult))
      .toEqual(results)
    expect(lines.every((line) => !line.includes('\n'))).toBe(true)
  })

  it('writes a lone newline for an empty result set', async () => {
    const target = path.join(directory, 'empty.task-ab.jsonl')
    await writeDeepSeekTaskResults([], target)

    expect(await readFile(target, 'utf8')).toBe('\n')
  })
})
