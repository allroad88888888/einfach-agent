import { callModel, type ModelItem } from '@web-agent/ai'
import type { ContextCheckpoint } from '../state/contextCheckpoint.type'
import type { ModelSettings } from '../state/core.type'
import { estimateItemsTokens, estimateTokensFromText } from './contextCompaction'
import { buildContextDistillationMessages, CONTEXT_DISTILLATION_MAX_TOKENS } from './contextDistillationPrompt'
import { parseContextDistillationResponse } from './contextDistillationResult'
import { stringForStats } from './shared/preview'

export interface ContextDistillationInput {
  stablePrefix: readonly ModelItem[]
  transcript: readonly ModelItem[]
  coveredItemIds: string[]
  settings: ModelSettings
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  userId?: string
}

/** True when the request projection plus tool schemas cannot fit its input budget. */
export function contextNeedsDistillation(
  messages: readonly ModelItem[],
  tools: unknown,
  inputBudgetTokens: number,
): boolean {
  return estimateItemsTokens(messages) + estimateTokensFromText(stringForStats(tools)) > inputBudgetTokens
}

/** Requests a structured model-authored checkpoint for the supplied transcript projection. */
export async function createContextCheckpoint(
  input: ContextDistillationInput,
): Promise<ContextCheckpoint> {
  const response = await callModel({
    model: input.settings.model,
    messages: buildContextDistillationMessages(input.stablePrefix, input.transcript),
    ...(input.settings.vendor === 'kimi' ? {} : { temperature: 0 }),
    max_tokens: CONTEXT_DISTILLATION_MAX_TOKENS,
    tools: [],
    tool_choice: 'none',
    stream: false,
    settings: input.settings,
    userId: input.userId,
  }, {
    apiKey: input.apiKey,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  })
  const summary = parseContextDistillationResponse(response)
  if (!summary) throw new Error('上下文摘要模型没有返回有效内容，已保留原始历史；请重试本轮。')
  return {
    schemaVersion: 1,
    summary,
    coveredItemIds: input.coveredItemIds,
    createdAt: Date.now(),
    sourceEstimatedTokens: estimateItemsTokens(input.transcript),
  }
}
