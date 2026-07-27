import { describe, expect, it } from 'vitest'
import {
  calculateDeepSeekTaskCost,
  DEEPSEEK_TASK_PRICE_SCHEDULE,
} from './task-cost'
import type { DeepSeekTaskAbResult } from './task-runner'
import {
  DEEPSEEK_TASK_RESULT_SCHEMA,
  DEEPSEEK_TASK_SUITE_VERSION,
} from './task-suite'

const BASE_RESULT: DeepSeekTaskAbResult = {
  schema_version: DEEPSEEK_TASK_RESULT_SCHEMA,
  suite_version: DEEPSEEK_TASK_SUITE_VERSION,
  run_id: 'run-cost-test',
  replicate: 0,
  order_index: 1,
  task_id: 'T01',
  category: 'extraction',
  fixture_sha256: 'a'.repeat(64),
  prompt_version: 'prompt-test-1',
  scorer_version: 'scorer-test-1',
  route_features: {
    task_category: 'extraction',
    risk_level: 'low',
    cross_module: false,
    final_acceptance: false,
    requires_temporal_normalization: false,
  },
  shadow_route: { tier: 'flash', reason: 'test' },
  arm: 'pro',
  model: 'deepseek-v4-pro',
  response_model: 'deepseek-v4-pro',
  profile: {
    thinking: false,
    reasoning_effort: null,
    stream: false,
    max_tokens: 1_024,
  },
  score: { earned: 100, max: 100, pass: true, hardFailures: [], components: {} },
  timing: { wall_ms: 10, ttft_ms: null },
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
  },
  tokens: {
    input: 20,
    output: 5,
    total: 25,
    cache_hit: 8,
    cache_miss: 12,
    cache_miss_source: 'provider',
  },
  fallback_count: 0,
  output_sha256: 'b'.repeat(64),
  error: null,
}

interface ResultOverrides {
  model?: string
  response_model?: string | null
  tokens?: Partial<DeepSeekTaskAbResult['tokens']>
}

function result(overrides: ResultOverrides = {}): DeepSeekTaskAbResult {
  const { tokens, ...rest } = overrides
  return {
    ...BASE_RESULT,
    ...rest,
    tokens: { ...BASE_RESULT.tokens, ...tokens },
  }
}

const NO_TOKENS: DeepSeekTaskAbResult['tokens'] = {
  input: null,
  output: null,
  total: null,
  cache_hit: null,
  cache_miss: null,
  cache_miss_source: 'unknown',
}

describe('calculateDeepSeekTaskCost price schedule identity', () => {
  it('stamps every result with the pinned schedule id and currency', () => {
    const cost = calculateDeepSeekTaskCost(result())
    expect(cost.schedule_id).toBe('deepseek-v4-usd-2026-07-24-v1')
    expect(cost.currency).toBe('USD')
    expect(DEEPSEEK_TASK_PRICE_SCHEDULE.unit_tokens).toBe(1_000_000)
    // 未知模型分支也必须保留同一份价目表身份，报告才能按 schedule 聚合。
    expect(calculateDeepSeekTaskCost(result({ model: 'gpt-4o' }))).toMatchObject({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
    })
  })
})

describe('calculateDeepSeekTaskCost complete pricing', () => {
  it('prices a Pro run from the cache hit/miss/output split', () => {
    // 1000 * 3_625 = 3_625_000
    // 500 * 435_000 = 217_500_000
    // 200 * 870_000 = 174_000_000
    // 上界：1500 * 435_000 + 200 * 870_000 = 652_500_000 + 174_000_000
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v4-pro',
      tokens: {
        input: 1_500,
        output: 200,
        total: 1_700,
        cache_hit: 1_000,
        cache_miss: 500,
        cache_miss_source: 'provider',
      },
    }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'complete',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: 395_125_000,
      conservative_upper_cost_pico_usd: 826_500_000,
    })
  })

  it('prices a Flash run at the cheaper Flash rates', () => {
    // 2000 * 2_800 = 5_600_000
    // 3000 * 140_000 = 420_000_000
    // 400 * 280_000 = 112_000_000
    // 上界：5000 * 140_000 + 400 * 280_000 = 700_000_000 + 112_000_000
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-flash',
      tokens: {
        input: 5_000,
        output: 400,
        total: 5_400,
        cache_hit: 2_000,
        cache_miss: 3_000,
        cache_miss_source: 'provider',
      },
    }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'complete',
      priced_model: 'deepseek-v4-flash',
      exact_cost_pico_usd: 537_600_000,
      conservative_upper_cost_pico_usd: 812_000_000,
    })
  })

  it('accepts a derived cache-miss split and a fully cached prompt', () => {
    // 全命中：1000 * 2_800 = 2_800_000；output 0 不计。
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-flash',
      tokens: {
        input: 1_000,
        output: 0,
        total: 1_000,
        cache_hit: 1_000,
        cache_miss: 0,
        cache_miss_source: 'derived',
      },
    }))).toMatchObject({
      status: 'complete',
      exact_cost_pico_usd: 2_800_000,
      conservative_upper_cost_pico_usd: 140_000_000,
    })
  })

  it('degrades to invalid_usage when the exact cost overflows safe integers', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: {
        input: 9_000_000_000_000,
        output: 0,
        total: 9_000_000_000_000,
        cache_hit: 0,
        cache_miss: 9_000_000_000_000,
        cache_miss_source: 'provider',
      },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost unknown_model', () => {
  it('refuses to price a model that is absent from the schedule', () => {
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v5-turbo',
      response_model: 'deepseek-v5-turbo',
    }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'unknown_model',
      priced_model: null,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('checks the requested model before the response model', () => {
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v5-turbo',
      response_model: 'deepseek-v4-pro',
    }))).toMatchObject({
      status: 'unknown_model',
      priced_model: null,
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost no_response', () => {
  // response_model 为 null 代表一个响应都没回（transport 失败），与「路由到了别的模型」
  // 是两回事。两者都算 incomplete，但不能共用 model_mismatch 这个标签。
  it('separates a missing response from a genuine model mismatch', () => {
    // 只有 pro 参与上界：20 * 435_000 + 5 * 870_000 = 8_700_000 + 4_350_000
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-pro',
      response_model: null,
    }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'no_response',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('returns before inspecting usage completeness', () => {
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-pro',
      response_model: null,
      tokens: NO_TOKENS,
    }))).toMatchObject({
      status: 'no_response',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost model_mismatch', () => {
  it('takes the worst rate across both known models when they disagree', () => {
    // miss 取 max(140_000, 435_000)，output 取 max(280_000, 870_000)：
    // 100 * 435_000 + 10 * 870_000 = 43_500_000 + 8_700_000
    // （若只按 flash 计价会得到 16_800_000，本断言正好排除这种实现。）
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-pro',
      tokens: { input: 100, output: 10, total: 110 },
    }))).toMatchObject({
      status: 'model_mismatch',
      priced_model: 'deepseek-v4-flash',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 52_200_000,
    })
  })

  it('drops the upper bound when the response model is unpriced', () => {
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v5-turbo',
    }))).toMatchObject({
      status: 'model_mismatch',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('reports a mismatch before inspecting usage completeness', () => {
    // 用真实的另一个已知模型，而不是 null —— null 现在归 no_response，
    // 若继续用 null，「mismatch 短路于 usage 检查」这条语义就没有测试守着了。
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v4-flash',
      tokens: NO_TOKENS,
    }))).toMatchObject({
      status: 'model_mismatch',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost usage_missing', () => {
  it('separates a wholly absent usage block from a corrupt one', () => {
    expect(calculateDeepSeekTaskCost(result({ tokens: NO_TOKENS }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'usage_missing',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('still reports usage_missing when only the cache split survived', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { ...NO_TOKENS, cache_hit: 8, cache_miss: 12, cache_miss_source: 'provider' },
    }))).toMatchObject({
      status: 'usage_missing',
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost invalid_usage', () => {
  it('rejects a partial base usage block but keeps the input/output upper bound', () => {
    // 20 * 435_000 + 5 * 870_000
    expect(calculateDeepSeekTaskCost(result({
      tokens: { ...NO_TOKENS, input: 20, output: 5 },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('falls back to the max single rate when only a total is reported', () => {
    // 25 * max(435_000, 870_000) = 25 * 870_000
    expect(calculateDeepSeekTaskCost(result({
      tokens: { ...NO_TOKENS, total: 25 },
    }))).toMatchObject({
      status: 'invalid_usage',
      conservative_upper_cost_pico_usd: 21_750_000,
    })
  })

  it('uses the Flash output rate for a total-only Flash run', () => {
    // 1000 * max(140_000, 280_000) = 1000 * 280_000
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-flash',
      tokens: { ...NO_TOKENS, total: 1_000 },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-flash',
      conservative_upper_cost_pico_usd: 280_000_000,
    })
  })

  it('rejects an input/output split that does not add up to the total', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { input: 20, output: 5, total: 30, cache_hit: 8, cache_miss: 12 },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('rejects a cache split that does not add up to the input tokens', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { input: 20, output: 5, total: 25, cache_hit: 8, cache_miss: 13 },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('rejects a half-populated cache split and keeps the upper bound', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { cache_hit: 8, cache_miss: null, cache_miss_source: 'derived' },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('rejects an otherwise consistent split whose miss source is unknown', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { cache_miss_source: 'unknown' },
    }))).toMatchObject({
      status: 'invalid_usage',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('treats negative token counts as corrupt rather than priceable', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { input: -20, output: 5, total: -15, cache_hit: -8, cache_miss: -12 },
    }))).toMatchObject({
      status: 'invalid_usage',
      exact_cost_pico_usd: null,
      // input 非法 -> 上界退回 total，total 同样非法 -> 无上界。
      conservative_upper_cost_pico_usd: null,
    })
  })
})

describe('calculateDeepSeekTaskCost cache_split_missing', () => {
  it('reports a priceable-but-unsplit run with only an upper bound', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: { cache_hit: null, cache_miss: null, cache_miss_source: 'unknown' },
    }))).toEqual({
      schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
      currency: 'USD',
      status: 'cache_split_missing',
      priced_model: 'deepseek-v4-pro',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('checks the arithmetic of the base usage before the cache split', () => {
    expect(calculateDeepSeekTaskCost(result({
      tokens: {
        input: 20,
        output: 5,
        total: 26,
        cache_hit: null,
        cache_miss: null,
        cache_miss_source: 'unknown',
      },
    }))).toMatchObject({
      status: 'invalid_usage',
      conservative_upper_cost_pico_usd: null,
    })
  })

  it('bounds an unsplit Flash run at the Flash miss/output rates', () => {
    // 5000 * 140_000 + 400 * 280_000
    expect(calculateDeepSeekTaskCost(result({
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-flash',
      tokens: {
        input: 5_000,
        output: 400,
        total: 5_400,
        cache_hit: null,
        cache_miss: null,
        cache_miss_source: 'unknown',
      },
    }))).toMatchObject({
      status: 'cache_split_missing',
      priced_model: 'deepseek-v4-flash',
      conservative_upper_cost_pico_usd: 812_000_000,
    })
  })
})

describe('calculateDeepSeekTaskCost conservative upper bound', () => {
  it('never prices a complete run above its own upper bound', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-v4-flash'] as const) {
      const cost = calculateDeepSeekTaskCost(result({
        model,
        response_model: model,
        tokens: {
          input: 5_000,
          output: 400,
          total: 5_400,
          cache_hit: 4_000,
          cache_miss: 1_000,
          cache_miss_source: 'provider',
        },
      }))
      expect(cost.status, model).toBe('complete')
      expect(cost.exact_cost_pico_usd, model).not.toBeNull()
      expect(cost.conservative_upper_cost_pico_usd, model).not.toBeNull()
      expect(cost.exact_cost_pico_usd!, model)
        .toBeLessThan(cost.conservative_upper_cost_pico_usd!)
    }
  })
})
