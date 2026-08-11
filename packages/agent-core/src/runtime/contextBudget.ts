import { contextWindowTokens } from '@web-agent/ai'

export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000
export const CONTEXT_SAFETY_MARGIN_RATIO = 0.08
export const COST_SOFT_CAP_TOKENS = 200_000

/** Calculates the input budget shared by normal requests and distillation. */
export function contextInputBudgetTokens(
  vendor: string,
  model: string,
  reservedOutputTokens = DEFAULT_RESERVED_OUTPUT_TOKENS,
): number {
  const requestBudget = Math.min(contextWindowTokens(vendor, model), COST_SOFT_CAP_TOKENS)
  return Math.max(
    0,
    requestBudget - reservedOutputTokens - Math.ceil(requestBudget * CONTEXT_SAFETY_MARGIN_RATIO),
  )
}
