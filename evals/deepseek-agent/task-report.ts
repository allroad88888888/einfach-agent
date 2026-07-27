import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  calculateDeepSeekTaskCost,
  DEEPSEEK_TASK_PRICE_SCHEDULE,
} from './task-cost'
import type { DeepSeekTaskAbResult } from './task-runner'

export interface DeepSeekTaskArmSummary {
  runs: number
  passes: number
  pass_rate: number
  average_score: number
  wall_p50_ms: number | null
  wall_p95_ms: number | null
  total_tokens: number
  input_tokens: number | null
  output_tokens: number | null
  cache_hit_tokens: number | null
  cache_miss_tokens: number | null
  cache_hit_ratio: number | null
  cost_complete_runs: number
  cost_incomplete_runs: number
  total_cost_pico_usd: number | null
  conservative_upper_cost_pico_usd: number | null
  cost_per_pass_pico_usd: number | null
}

export interface DeepSeekTaskPolicySummary extends DeepSeekTaskArmSummary {
  /** 基线是【配对后的 Pro 子集】，不是全量 Pro 臂 —— 影子策略只在配对子集上有定义。 */
  passes_lost_vs_paired_pro: number
  paired_regressions: number
  paired_improvements: number
  total_cost_savings_ratio: number | null
  cost_per_pass_savings_ratio: number | null
}

export type DeepSeekTaskReleaseGateFailure =
  | 'no_paired_results'
  | 'incomplete_pairs'
  | 'incomplete_cost_data'
  | 'shadow_pass_rate_regression'
  | 'paired_quality_regression'
  | 'shadow_hard_failure'
  | 'shadow_tool_protocol_error'
  | 'shadow_latency_regression'
  | 'cost_per_pass_savings_below_target'
  | 'no_total_cost_savings'

export interface DeepSeekTaskReleaseGate {
  pass: boolean
  failure_reasons: DeepSeekTaskReleaseGateFailure[]
  thresholds: {
    max_pass_rate_drop: number
    max_p95_ratio: number
    max_tool_protocol_error_rate: number
    min_cost_per_pass_savings_ratio: number
    max_paired_regressions: number
  }
  checks: {
    data_complete: boolean
    quality: boolean
    safety: boolean
    latency: boolean
    economics: boolean
  }
}

export interface DeepSeekTaskSummary {
  runs: number
  pairs: number
  pricing_schedule: typeof DEEPSEEK_TASK_PRICE_SCHEDULE
  arms: Record<'pro' | 'flash', DeepSeekTaskArmSummary>
  paired_pro_minus_flash_average_score: number
  shadow_policy: DeepSeekTaskPolicySummary
  hard_failures: number
  tool_schema_errors: number
  unexpected_tools: number
  duplicate_exact_tool_calls: number
  release_gate: DeepSeekTaskReleaseGate
}

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values: number[], quantile: number): number | null {
  const finiteValues = values.filter(
    (value) => Number.isFinite(value) && value >= 0,
  )
  if (finiteValues.length === 0) return null
  const sorted = [...finiteValues].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index] ?? null
}

function safeIntegerSum(values: Array<number | null>): number | null {
  if (
    values.length === 0
    || values.some(
      (value) => value === null || !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    return null
  }
  let total = 0
  for (const value of values) {
    total += value ?? 0
    if (!Number.isSafeInteger(total)) return null
  }
  return total
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (
    numerator === null
    || denominator === null
    || !Number.isFinite(numerator)
    || !Number.isFinite(denominator)
    || denominator <= 0
  ) {
    return null
  }
  const ratio = numerator / denominator
  return Number.isFinite(ratio) ? ratio : null
}

function integerCostPerPass(totalCost: number | null, passes: number): number | null {
  if (totalCost === null || passes <= 0) return null
  const value = Math.round(totalCost / passes)
  return Number.isSafeInteger(value) ? value : null
}

function armSummary(results: DeepSeekTaskAbResult[]): DeepSeekTaskArmSummary {
  const passes = results.filter((result) => result.score.pass).length
  const totalTokens = safeIntegerSum(results.map((result) => result.tokens.total))
  const inputTokens = safeIntegerSum(results.map((result) => result.tokens.input))
  const outputTokens = safeIntegerSum(results.map((result) => result.tokens.output))
  const cacheHitTokens = safeIntegerSum(
    results.map((result) => result.tokens.cache_hit),
  )
  const cacheMissTokens = safeIntegerSum(
    results.map((result) => result.tokens.cache_miss),
  )
  const cacheInputTokens =
    cacheHitTokens === null || cacheMissTokens === null
      ? null
      : Number.isSafeInteger(cacheHitTokens + cacheMissTokens)
        ? cacheHitTokens + cacheMissTokens
        : null
  const costs = results.map(calculateDeepSeekTaskCost)
  const exactCosts = costs.map((cost) => cost.exact_cost_pico_usd)
  const upperCosts = costs.map((cost) => cost.conservative_upper_cost_pico_usd)
  const totalCost = safeIntegerSum(exactCosts)
  const cacheRatio = safeRatio(cacheHitTokens, cacheInputTokens)
  return {
    runs: results.length,
    passes,
    pass_rate: results.length > 0 ? round(passes / results.length) : 0,
    average_score:
      results.length > 0
        ? round(results.reduce((sum, result) => sum + result.score.earned, 0) / results.length, 2)
        : 0,
    wall_p50_ms: percentile(results.map((result) => result.timing.wall_ms), 0.5),
    wall_p95_ms: percentile(results.map((result) => result.timing.wall_ms), 0.95),
    total_tokens: totalTokens ?? 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_hit_tokens: cacheHitTokens,
    cache_miss_tokens: cacheMissTokens,
    cache_hit_ratio:
      cacheRatio === null ? null : round(cacheRatio, 6),
    cost_complete_runs: costs.filter((cost) => cost.status === 'complete').length,
    cost_incomplete_runs: costs.filter((cost) => cost.status !== 'complete').length,
    total_cost_pico_usd: totalCost,
    conservative_upper_cost_pico_usd: safeIntegerSum(upperCosts),
    cost_per_pass_pico_usd: integerCostPerPass(totalCost, passes),
  }
}

function pairKey(result: DeepSeekTaskAbResult): string {
  return `${result.replicate}:${result.task_id}`
}

const RELEASE_THRESHOLDS = {
  max_pass_rate_drop: 0.01,
  max_p95_ratio: 1.10,
  max_tool_protocol_error_rate: 0.005,
  min_cost_per_pass_savings_ratio: 0.25,
  max_paired_regressions: 0,
} as const

export function summarizeDeepSeekTaskResults(
  results: DeepSeekTaskAbResult[],
): DeepSeekTaskSummary {
  const pro = results.filter((result) => result.arm === 'pro')
  const flash = results.filter((result) => result.arm === 'flash')
  const proByPair = new Map(pro.map((result) => [pairKey(result), result]))
  const flashByPair = new Map(flash.map((result) => [pairKey(result), result]))
  const pairedKeys = [...proByPair.keys()].filter((key) => flashByPair.has(key))
  const scoreGap = pairedKeys.reduce((sum, key) => {
    return sum
      + (proByPair.get(key)?.score.earned ?? 0)
      - (flashByPair.get(key)?.score.earned ?? 0)
  }, 0)
  const shadowPolicy = pairedKeys
    .map((key) => {
      const proResult = proByPair.get(key)!
      const flashResult = flashByPair.get(key)!
      return proResult.shadow_route.tier === 'flash' ? flashResult : proResult
    })
  const proSummary = armSummary(pro)
  const flashSummary = armSummary(flash)
  const shadowSummary = armSummary(shadowPolicy)
  const shadowPasses = shadowPolicy.filter((result) => result.score.pass).length
  const pairedPro = pairedKeys.map((key) => proByPair.get(key)!)
  const pairedProPasses = pairedPro.filter((result) => result.score.pass).length
  // 影子策略只在配对子集上有定义，所以每个基线对比（通过率、配对回归、成本、时延）都必须
  // 以配对后的 Pro 子集为分母。用全量 Pro 会在「部分配对」时造成分子分母口径不一致，
  // 让节省比偏乐观。arms.pro 仍报告完整 Pro 臂，不受影响。
  const pairedProSummary = armSummary(pairedPro)
  const pairedRegressions = shadowPolicy.filter(
    (result, index) => pairedPro[index]?.score.pass && !result.score.pass,
  ).length
  const pairedImprovements = shadowPolicy.filter(
    (result, index) => !pairedPro[index]?.score.pass && result.score.pass,
  ).length
  const shadowToProTotalCostRatio =
    safeRatio(shadowSummary.total_cost_pico_usd, pairedProSummary.total_cost_pico_usd)
  const shadowCostPerPass =
    shadowSummary.total_cost_pico_usd === null || shadowPasses <= 0
      ? null
      : shadowSummary.total_cost_pico_usd / shadowPasses
  const proCostPerPass =
    pairedProSummary.total_cost_pico_usd === null || pairedProPasses <= 0
      ? null
      : pairedProSummary.total_cost_pico_usd / pairedProPasses
  const shadowToProCostPerPassRatio =
    safeRatio(shadowCostPerPass, proCostPerPass)
  const rawTotalCostSavings =
    shadowToProTotalCostRatio === null ? null : 1 - shadowToProTotalCostRatio
  const rawCostPerPassSavings =
    shadowToProCostPerPassRatio === null
      ? null
      : 1 - shadowToProCostPerPassRatio
  const normalizedTotalCostSavings =
    rawTotalCostSavings === null ? null : round(rawTotalCostSavings, 6)
  const normalizedCostPerPassSavings =
    rawCostPerPassSavings === null ? null : round(rawCostPerPassSavings, 6)
  const pairedComplete =
    pairedKeys.length > 0
    && pro.length === pairedKeys.length
    && flash.length === pairedKeys.length
    && results.length === pairedKeys.length * 2
  const costDataComplete =
    proSummary.cost_incomplete_runs === 0
    && flashSummary.cost_incomplete_runs === 0
    && shadowSummary.cost_incomplete_runs === 0
    && proSummary.total_cost_pico_usd !== null
    && flashSummary.total_cost_pico_usd !== null
    && shadowSummary.total_cost_pico_usd !== null
  const rawProPassRate = pairedPro.length > 0 ? pairedProPasses / pairedPro.length : null
  const rawShadowPassRate =
    shadowPolicy.length > 0 ? shadowPasses / shadowPolicy.length : null
  const passRateAcceptable =
    rawProPassRate !== null
    && rawShadowPassRate !== null
    && rawShadowPassRate >= rawProPassRate - RELEASE_THRESHOLDS.max_pass_rate_drop
  const shadowHardFailures = shadowPolicy.reduce(
    (sum, result) => sum + result.score.hardFailures.length,
    0,
  )
  const shadowToolProtocolErrors = shadowPolicy.reduce(
    (sum, result) =>
      sum
      + result.tools.schema_errors
      + result.tools.unexpected
      + result.tools.duplicate_exact_calls,
    0,
  )
  const toolProtocolErrorRate =
    shadowPolicy.length > 0 ? shadowToolProtocolErrors / shadowPolicy.length : null
  const latencyAcceptable =
    pairedProSummary.wall_p95_ms !== null
    && shadowSummary.wall_p95_ms !== null
    && shadowSummary.wall_p95_ms
      <= pairedProSummary.wall_p95_ms * RELEASE_THRESHOLDS.max_p95_ratio
  const costPerPassAcceptable =
    rawCostPerPassSavings !== null
    && rawCostPerPassSavings
      >= RELEASE_THRESHOLDS.min_cost_per_pass_savings_ratio
  const totalCostAcceptable =
    rawTotalCostSavings !== null && rawTotalCostSavings > 0
  const checks: DeepSeekTaskReleaseGate['checks'] = {
    data_complete: pairedComplete && costDataComplete,
    quality:
      passRateAcceptable
      && pairedRegressions <= RELEASE_THRESHOLDS.max_paired_regressions,
    safety:
      shadowHardFailures === 0
      && toolProtocolErrorRate !== null
      && toolProtocolErrorRate <= RELEASE_THRESHOLDS.max_tool_protocol_error_rate,
    latency: latencyAcceptable,
    economics: costPerPassAcceptable && totalCostAcceptable,
  }
  const failureReasons: DeepSeekTaskReleaseGateFailure[] = []
  if (pairedKeys.length === 0) failureReasons.push('no_paired_results')
  else if (!pairedComplete) failureReasons.push('incomplete_pairs')
  if (!costDataComplete) failureReasons.push('incomplete_cost_data')
  if (!passRateAcceptable) failureReasons.push('shadow_pass_rate_regression')
  if (pairedRegressions > RELEASE_THRESHOLDS.max_paired_regressions) {
    failureReasons.push('paired_quality_regression')
  }
  if (shadowHardFailures > 0) failureReasons.push('shadow_hard_failure')
  if (
    toolProtocolErrorRate === null
    || toolProtocolErrorRate > RELEASE_THRESHOLDS.max_tool_protocol_error_rate
  ) {
    failureReasons.push('shadow_tool_protocol_error')
  }
  if (!latencyAcceptable) failureReasons.push('shadow_latency_regression')
  if (!costPerPassAcceptable) {
    failureReasons.push('cost_per_pass_savings_below_target')
  }
  if (!totalCostAcceptable) failureReasons.push('no_total_cost_savings')

  return {
    runs: results.length,
    pairs: pairedKeys.length,
    pricing_schedule: DEEPSEEK_TASK_PRICE_SCHEDULE,
    arms: {
      pro: proSummary,
      flash: flashSummary,
    },
    paired_pro_minus_flash_average_score:
      pairedKeys.length > 0 ? round(scoreGap / pairedKeys.length, 2) : 0,
    shadow_policy: {
      ...shadowSummary,
      passes_lost_vs_paired_pro: Math.max(0, pairedProPasses - shadowPasses),
      paired_regressions: pairedRegressions,
      paired_improvements: pairedImprovements,
      total_cost_savings_ratio: normalizedTotalCostSavings,
      cost_per_pass_savings_ratio: normalizedCostPerPassSavings,
    },
    hard_failures: results.reduce(
      (sum, result) => sum + result.score.hardFailures.length,
      0,
    ),
    tool_schema_errors: results.reduce(
      (sum, result) => sum + result.tools.schema_errors,
      0,
    ),
    unexpected_tools: results.reduce(
      (sum, result) => sum + result.tools.unexpected,
      0,
    ),
    duplicate_exact_tool_calls: results.reduce(
      (sum, result) => sum + result.tools.duplicate_exact_calls,
      0,
    ),
    release_gate: {
      pass: failureReasons.length === 0 && Object.values(checks).every(Boolean),
      failure_reasons: failureReasons,
      thresholds: RELEASE_THRESHOLDS,
      checks,
    },
  }
}

export function defaultDeepSeekTaskResultPath(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(':', '-')
  return path.resolve(
    'evals/deepseek-agent/results',
    `${timestamp}.task-ab.jsonl`,
  )
}

export async function writeDeepSeekTaskResults(
  results: DeepSeekTaskAbResult[],
  resultPath = defaultDeepSeekTaskResultPath(),
): Promise<string> {
  const absolutePath = path.resolve(resultPath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  const jsonl = results.map((result) => JSON.stringify(result)).join('\n')
  await writeFile(absolutePath, `${jsonl}\n`, 'utf8')
  return absolutePath
}
