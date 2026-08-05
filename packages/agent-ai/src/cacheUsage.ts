import type { ModelUsage } from './modelProtocol'

export interface CacheUsage {
  hitTokens?: number
  missTokens?: number
  missSource: 'provider' | 'derived' | 'unknown'
  writeTokens?: number
  totalInputTokens?: number
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = nonNegativeFiniteNumber(value)
    if (number !== undefined) return number
  }
  return undefined
}

/** Normalizes provider-specific prompt-cache counters without inventing missing metrics. */
export function normalizeCacheUsage(usage?: ModelUsage | null): CacheUsage | undefined {
  if (!usage) return undefined

  const totalInputTokens = firstNumber(usage.prompt_tokens, usage.input_tokens)
  let hitTokens = firstNumber(
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.cached_tokens,
  )
  const providerMissTokens = nonNegativeFiniteNumber(usage.prompt_cache_miss_tokens)
  let missTokens = providerMissTokens
  let missSource: CacheUsage['missSource'] =
    providerMissTokens === undefined ? 'unknown' : 'provider'
  const writeTokens = firstNumber(
    usage.prompt_cache_write_tokens,
    usage.cache_creation_input_tokens,
  )

  if (hitTokens === undefined && missTokens === undefined && writeTokens === undefined) {
    return undefined
  }

  if (
    totalInputTokens !== undefined
    && ((hitTokens !== undefined && hitTokens > totalInputTokens)
      || (missTokens !== undefined && missTokens > totalInputTokens)
      || (hitTokens !== undefined
        && missTokens !== undefined
        && hitTokens + missTokens !== totalInputTokens))
  ) {
    return undefined
  }

  if (missTokens === undefined && hitTokens !== undefined && totalInputTokens !== undefined) {
    missTokens = totalInputTokens - hitTokens
    missSource = 'derived'
  }
  if (hitTokens === undefined && missTokens !== undefined && totalInputTokens !== undefined) {
    hitTokens = totalInputTokens - missTokens
  }

  return { hitTokens, missTokens, missSource, writeTokens, totalInputTokens }
}
