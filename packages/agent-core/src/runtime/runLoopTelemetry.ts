import { normalizeCacheUsage, type ModelChatResponse, type ModelFunctionTool, type ModelItem } from '@web-agent/ai'
import type {
  ContextCacheTotals,
  ContextStatsSnapshot,
  ContextUsageStats,
} from '../state/transientAtoms'
import { estimateTokensFromText } from './contextCompaction'
import type { ContextCacheProfile } from './contextCache'
import { newId } from './newId'
import { stringForStats } from './shared/preview'
import { truncatePayload } from '../observability/redact'
import type { TraceAttributes } from '../observability/types'

const LLM_TRACE_PREVIEW_LIMIT = 80_000
const LLM_TRACE_PREVIEW_OPTIONS = {
  stringLimit: LLM_TRACE_PREVIEW_LIMIT,
  depth: 8,
  itemLimit: 1_000,
  keyLimit: 400,
}

function cacheHitRate(hitTokens?: number, missTokens?: number): number | undefined {
  if (typeof hitTokens !== 'number' || typeof missTokens !== 'number') return undefined
  const total = hitTokens + missTokens
  return total > 0 ? hitTokens / total : undefined
}

export function usageTraceAttrs(usage: ModelChatResponse['usage']): TraceAttributes {
  const attrs: TraceAttributes = {}
  if (typeof usage?.prompt_tokens === 'number') attrs.prompt_tokens = usage.prompt_tokens
  if (typeof usage?.completion_tokens === 'number') attrs.completion_tokens = usage.completion_tokens
  if (typeof usage?.total_tokens === 'number') attrs.total_tokens = usage.total_tokens
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens === 'number') attrs.cache_hit_tk = cache.hitTokens
  if (typeof cache?.missTokens === 'number') attrs.cache_miss_tk = cache.missTokens
  if (typeof cache?.writeTokens === 'number') attrs.cache_write_tk = cache.writeTokens
  if (cache?.missSource) attrs.cache_miss_source = cache.missSource
  const rate = cacheHitRate(cache?.hitTokens, cache?.missTokens)
  if (typeof rate === 'number') attrs.cache_hit_rate = rate
  return attrs
}

export function responseChars(value: string | null | undefined): number {
  return typeof value === 'string' ? value.length : 0
}

export function llmTracePreview(value: unknown): string {
  return truncatePayload(value, LLM_TRACE_PREVIEW_LIMIT, LLM_TRACE_PREVIEW_OPTIONS)
}

export function toolNames(tools: ModelFunctionTool[]): string[] {
  return tools.map((tool) => tool.function.name)
}

export function usageStats(usage: ModelChatResponse['usage']): ContextUsageStats | undefined {
  const stats: ContextUsageStats = {}
  if (typeof usage?.prompt_tokens === 'number') stats.promptTokens = usage.prompt_tokens
  if (typeof usage?.completion_tokens === 'number') stats.completionTokens = usage.completion_tokens
  if (typeof usage?.total_tokens === 'number') stats.totalTokens = usage.total_tokens
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens === 'number') stats.cacheHitTokens = cache.hitTokens
  if (typeof cache?.missTokens === 'number') stats.cacheMissTokens = cache.missTokens
  if (typeof cache?.writeTokens === 'number') stats.cacheWriteTokens = cache.writeTokens
  if (cache?.missSource) stats.cacheMissSource = cache.missSource
  const rate = cacheHitRate(cache?.hitTokens, cache?.missTokens)
  if (typeof rate === 'number') stats.cacheHitRate = rate
  return Object.keys(stats).length > 0 ? stats : undefined
}

export function accumulateCacheTotals(
  previous: ContextCacheTotals | undefined,
  usage: ModelChatResponse['usage'],
  runId: string,
): ContextCacheTotals | undefined {
  const scopedPrevious = previous?.runId === runId ? previous : undefined
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens !== 'number' || typeof cache.missTokens !== 'number') return scopedPrevious
  const hitTokens = (scopedPrevious?.hitTokens ?? 0) + cache.hitTokens
  const missTokens = (scopedPrevious?.missTokens ?? 0) + cache.missTokens
  return {
    runId,
    measuredRequests: (scopedPrevious?.measuredRequests ?? 0) + 1,
    hitTokens,
    missTokens,
    hitRate: cacheHitRate(hitTokens, missTokens),
  }
}

function emptyRoleStats() {
  return { count: 0, chars: 0, estimatedTokens: 0 }
}

export function buildContextStatsSnapshot(args: {
  runId: string
  turnId: string
  llmTurn: number
  vendor: string
  model: string
  messages: ModelItem[]
  tools: ModelFunctionTool[]
  cacheProfile: ContextCacheProfile
  cacheTotals?: ContextCacheTotals
  inputBudgetTokens: number
  estimatedTokensBeforeCompaction?: number
}): ContextStatsSnapshot {
  const roles: ContextStatsSnapshot['roles'] = {
    system: emptyRoleStats(), user: emptyRoleStats(), assistant: emptyRoleStats(), tool: emptyRoleStats(),
  }
  for (const message of args.messages) {
    const text = stringForStats(message)
    const roleStats = roles[message.role]
    roleStats.count += 1
    roleStats.chars += text.length
    roleStats.estimatedTokens += estimateTokensFromText(text)
  }
  const toolsText = stringForStats(args.tools)
  const messagesChars = roles.system.chars + roles.user.chars + roles.assistant.chars + roles.tool.chars
  const toolsChars = toolsText.length
  return {
    id: newId(), createdAt: Date.now(), vendor: args.vendor, model: args.model,
    runId: args.runId, turnId: args.turnId, llmTurn: args.llmTurn,
    messagesCount: args.messages.length, toolsCount: args.tools.length,
    systemChars: roles.system.chars, messagesChars, toolsChars, totalChars: messagesChars + toolsChars,
    estimatedTokens: roles.system.estimatedTokens + roles.user.estimatedTokens
      + roles.assistant.estimatedTokens + roles.tool.estimatedTokens + estimateTokensFromText(toolsText),
    estimatedTokensBeforeCompaction: args.estimatedTokensBeforeCompaction,
    inputBudgetTokens: args.inputBudgetTokens,
    roles,
    toolNames: toolNames(args.tools),
    cache: { ...args.cacheProfile, metricsStatus: 'pending' },
    cacheTotals: args.cacheTotals,
  }
}
