import { callModel, type ModelItem } from '@einfach-agent/ai'
import type { ModelSettings } from '../state/core.type'
import type { ContextSummaryRequest } from '../tools/contextCompaction'
import { estimateItemsTokens, estimateTokensFromText } from './contextCompactionEstimates'
import { buildContextDistillationMessages } from './contextDistillationPrompt'
import { parseContextDistillationResponse } from './contextDistillationResult'
import { modelAdapterSettings } from './modelSettingsProjection'
import { stringForStats } from './shared/preview'
import { projectTimedToolResultOrphans } from './timedToolResultProjection'

export interface ContextDistillationInput {
  stablePrefix: readonly ModelItem[]
  transcript: readonly ModelItem[]
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

/** Executes the tool's summary policy with runtime-owned context and credentials. */
export async function requestContextSummary(
  input: ContextDistillationInput,
  policy: ContextSummaryRequest,
): Promise<string> {
  // timed tool 结果只持久化为 role:'tool'，常规模型请求会在发送前补配对 assistant。
  // 摘要请求必须应用相同投影，否则 chat/completions 线协议会把历史中的孤儿 tool 消息拒为 400。
  const messages = projectTimedToolResultOrphans(
    buildContextDistillationMessages(input.stablePrefix, input.transcript, policy),
  )
  // temperature 一律带上（摘要要的是确定性）；固定采样参数的 provider 由自家 adapter
  // 在投影请求时丢弃它，core 不为此写厂商分支。
  const response = await callModel({
    model: input.settings.model,
    messages,
    temperature: 0,
    max_tokens: policy.maxOutputTokens,
    stream: false,
    settings: modelAdapterSettings(input.settings),
    userId: input.userId,
  }, {
    apiKey: input.apiKey,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  })
  const summary = parseContextDistillationResponse(response)
  if (!summary) throw new Error('上下文摘要模型没有返回有效内容，已保留原始历史；请重试本轮。')
  return summary
}
