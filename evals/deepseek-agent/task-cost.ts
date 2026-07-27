import type { DeepSeekTaskAbResult } from './task-runner'

export const PICO_USD_PER_USD = 1_000_000_000_000

export const DEEPSEEK_TASK_PRICE_SCHEDULE = {
  schedule_id: 'deepseek-v4-usd-2026-07-24-v1',
  currency: 'USD',
  unit_tokens: 1_000_000,
  source_path: 'research/deepseek/sources/api-docs/en/quick_start/pricing.html',
  source_sha256:
    '5ed7309f6b8bf5dbae559a012341aa604d02b0cce2e20c48aaa6f0a0bf287f89',
  rates_pico_usd_per_token: {
    'deepseek-v4-flash': {
      cache_hit_input: 2_800,
      cache_miss_input: 140_000,
      output: 280_000,
    },
    'deepseek-v4-pro': {
      cache_hit_input: 3_625,
      cache_miss_input: 435_000,
      output: 870_000,
    },
  },
} as const

export type DeepSeekPricedModel =
  keyof typeof DEEPSEEK_TASK_PRICE_SCHEDULE.rates_pico_usd_per_token

export type DeepSeekTaskCostStatus =
  | 'complete'
  | 'usage_missing'
  | 'cache_split_missing'
  | 'invalid_usage'
  | 'unknown_model'
  | 'no_response'
  | 'model_mismatch'

export interface DeepSeekTaskCost {
  status: DeepSeekTaskCostStatus
  schedule_id: typeof DEEPSEEK_TASK_PRICE_SCHEDULE.schedule_id
  currency: typeof DEEPSEEK_TASK_PRICE_SCHEDULE.currency
  priced_model: DeepSeekPricedModel | null
  exact_cost_pico_usd: number | null
  conservative_upper_cost_pico_usd: number | null
}

function isTokenCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0
}

function isPricedModel(model: string | null): model is DeepSeekPricedModel {
  return model !== null
    && Object.hasOwn(
      DEEPSEEK_TASK_PRICE_SCHEDULE.rates_pico_usd_per_token,
      model,
    )
}

function safeCost(terms: Array<[tokens: number, rate: number]>): number | null {
  let total = 0
  for (const [tokens, rate] of terms) {
    const amount = tokens * rate
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total + amount)) {
      return null
    }
    total += amount
  }
  return total
}

function usagePresence(tokens: DeepSeekTaskAbResult['tokens']): {
  baseComplete: boolean
  splitComplete: boolean
  anyBasePresent: boolean
  anySplitPresent: boolean
} {
  const base = [tokens.input, tokens.output, tokens.total]
  const split = [tokens.cache_hit, tokens.cache_miss]
  return {
    baseComplete: base.every(isTokenCount),
    splitComplete: split.every(isTokenCount),
    anyBasePresent: base.some((value) => value !== null),
    anySplitPresent: split.some((value) => value !== null),
  }
}

function conservativeUpper(
  result: DeepSeekTaskAbResult,
  models: DeepSeekPricedModel[],
): number | null {
  const rates = models.map(
    (model) => DEEPSEEK_TASK_PRICE_SCHEDULE.rates_pico_usd_per_token[model],
  )
  const missRate = Math.max(...rates.map((rate) => rate.cache_miss_input))
  const outputRate = Math.max(...rates.map((rate) => rate.output))
  const { input, output, total } = result.tokens
  if (isTokenCount(input) && isTokenCount(output)) {
    return safeCost([
      [input, missRate],
      [output, outputRate],
    ])
  }
  if (isTokenCount(total)) {
    return safeCost([[total, Math.max(missRate, outputRate)]])
  }
  return null
}

export function calculateDeepSeekTaskCost(
  result: DeepSeekTaskAbResult,
): DeepSeekTaskCost {
  const base = {
    schedule_id: DEEPSEEK_TASK_PRICE_SCHEDULE.schedule_id,
    currency: DEEPSEEK_TASK_PRICE_SCHEDULE.currency,
  } as const
  if (!isPricedModel(result.model)) {
    return {
      ...base,
      status: 'unknown_model',
      priced_model: null,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    }
  }

  const pricedModel = result.model
  const responseModel = isPricedModel(result.response_model)
    ? result.response_model
    : null
  const upper = conservativeUpper(
    result,
    responseModel === null ? [pricedModel] : [pricedModel, responseModel],
  )
  // 一个响应都没回（transport 失败、首轮就抛）时 runner 写入 response_model: null。那是
  // 「没跑成」，不是「路由到了别的模型」——混进 model_mismatch 会把传输故障误读成模型漂移。
  // 两者都算 incomplete，发布门禁的结论不变，变的是诊断可读性。
  if (result.response_model === null) {
    return {
      ...base,
      status: 'no_response',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: upper,
    }
  }
  if (result.response_model !== result.model) {
    return {
      ...base,
      status: 'model_mismatch',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      // 服务端返回的模型不在价目表里时，连保守上界都无从取值。
      conservative_upper_cost_pico_usd: responseModel !== null ? upper : null,
    }
  }

  const presence = usagePresence(result.tokens)
  if (!presence.baseComplete) {
    return {
      ...base,
      status: presence.anyBasePresent ? 'invalid_usage' : 'usage_missing',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: upper,
    }
  }
  const { input, output, total, cache_hit: hit, cache_miss: miss } = result.tokens
  // 这里和下面的 hit + miss !== input 是【算术自相矛盾】，与「某个字段缺失」性质不同：
  // 字段缺失时剩下的数字仍可信，所以照常给保守上界；而各项之间对不上，说明整份 usage 都不可信，
  // 基于它推出的上界同样没有意义 —— 故意返回 null，不要"顺手补齐"成 upper。
  if (input! + output! !== total!) {
    return {
      ...base,
      status: 'invalid_usage',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    }
  }
  if (!presence.splitComplete) {
    return {
      ...base,
      status: presence.anySplitPresent ? 'invalid_usage' : 'cache_split_missing',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: upper,
    }
  }
  if (result.tokens.cache_miss_source === 'unknown') {
    return {
      ...base,
      status: 'invalid_usage',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: upper,
    }
  }
  if (hit! + miss! !== input!) {
    return {
      ...base,
      status: 'invalid_usage',
      priced_model: pricedModel,
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: null,
    }
  }

  const rates =
    DEEPSEEK_TASK_PRICE_SCHEDULE.rates_pico_usd_per_token[pricedModel]
  const exact = safeCost([
    [hit!, rates.cache_hit_input],
    [miss!, rates.cache_miss_input],
    [output!, rates.output],
  ])
  return {
    ...base,
    status: exact === null ? 'invalid_usage' : 'complete',
    priced_model: pricedModel,
    exact_cost_pico_usd: exact,
    conservative_upper_cost_pico_usd: upper,
  }
}
