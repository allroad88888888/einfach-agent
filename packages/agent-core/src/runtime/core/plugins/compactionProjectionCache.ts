// 压缩投影缓存：持有一次完整压缩的稳定前缀，并在 append-only 历史中复用或增量延展它。
// ---------------------------------------------------------------------------
// 这个模块故意不知道 CoreCtx、trace 和动态控制尾巴：调用方负责请求预算与可观测性；这里仅维护
// 事实历史到请求投影的纯转换。拆出来避免 compactionPlugin 同时承担压缩编排和投影缓存两件事。

import type { ModelItem } from '@web-agent/ai'
import {
  compactContext,
  DEFAULT_KEEP_RECENT_TURNS,
  estimateItemsTokens,
} from '../../contextCompaction'

interface CompactionProjectionEntry {
  /** 产出该投影的事实历史快照；只按对象引用校验 append-only。 */
  source: readonly ModelItem[]
  /** 可直接作为后续请求稳定前缀的已压缩投影。 */
  projection: ModelItem[]
  projectionTokens: number
  summarizedToolResults: number
  droppedItems: number
  /** 自最近一次投影压缩后连续原文复用的次数。 */
  reuseCount: number
}

export interface CompactionProjectionCache {
  entry?: CompactionProjectionEntry
}

export interface ReusedProjection {
  items: ModelItem[]
  tokens: number
  appendedCount: number
  appendedTokens: number
}

export interface ExtendedProjection extends ReusedProjection {
  appendedTokensAfter: number
  previousProjectionTokens: number
  summarizedToolResults: number
  droppedItems: number
  reuseCountBeforeExtension: number
}

// 简介：创建一份会话级压缩投影缓存。
export function createCompactionProjectionCache(): CompactionProjectionCache {
  return {}
}

function isToolProtocolIntact(items: readonly ModelItem[]): boolean {
  const declared = new Set<string>()
  for (const item of items) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) declared.add(call.id)
      continue
    }
    if (item.role === 'tool' && !declared.has(item.tool_call_id)) return false
  }
  return true
}

function appendedHistory(
  entry: CompactionProjectionEntry,
  factHistory: readonly ModelItem[],
): ModelItem[] | undefined {
  const prefixLength = entry.source.length
  if (factHistory.length < prefixLength) return undefined
  for (let index = 0; index < prefixLength; index += 1) {
    if (factHistory[index] !== entry.source[index]) return undefined
  }
  return factHistory.slice(prefixLength)
}

// 简介：原文追加仍放得下时，复用稳定投影前缀。
export function tryReuseProjection(
  cache: CompactionProjectionCache,
  factHistory: readonly ModelItem[],
  effectiveBudget: number,
): ReusedProjection | undefined {
  const entry = cache.entry
  if (!entry) return undefined

  const appended = appendedHistory(entry, factHistory)
  if (!appended) return undefined
  const appendedTokens = estimateItemsTokens(appended)
  const tokens = entry.projectionTokens + appendedTokens
  if (tokens > effectiveBudget) return undefined

  const items = appended.length > 0 ? [...entry.projection, ...appended] : entry.projection
  return isToolProtocolIntact(items)
    ? { items, tokens, appendedCount: appended.length, appendedTokens }
    : undefined
}

// 简介：只压缩超出预算的新增尾段，保持既有投影逐项不变。
// 详情：全量重压会因保护窗口改变而改写约 15 万 token 的稳定前缀，导致 provider 前缀缓存失配。
// 本路径仅在 append-only 校验通过、原文追加确实超预算时运行；新增段独立按相同 CC1~CC5 规则
// 压缩，拼接后再次校验工具协议。任一条件不成立即返回 undefined，由调用方安全回落全量压缩。
export function tryExtendProjection(
  cache: CompactionProjectionCache,
  factHistory: readonly ModelItem[],
  effectiveBudget: number,
  replayUnsafeToolNames: ReadonlySet<string> | undefined,
): ExtendedProjection | undefined {
  const entry = cache.entry
  if (!entry) return undefined

  const appended = appendedHistory(entry, factHistory)
  if (!appended) return undefined
  const appendedTokens = estimateItemsTokens(appended)
  if (entry.projectionTokens + appendedTokens <= effectiveBudget) return undefined

  const remainingBudget = effectiveBudget - entry.projectionTokens
  if (remainingBudget <= 0) return undefined

  const tail = compactContext(appended, {
    maxTokens: remainingBudget,
    keepRecentTurns: DEFAULT_KEEP_RECENT_TURNS,
    replayUnsafeToolNames,
  })
  if (!tail.compacted || !tail.withinBudget) return undefined

  const items = [...entry.projection, ...tail.items]
  if (!isToolProtocolIntact(items)) return undefined

  const previousProjectionTokens = entry.projectionTokens
  const reuseCountBeforeExtension = entry.reuseCount
  entry.source = factHistory.slice()
  entry.projection = items
  entry.projectionTokens += tail.estimatedTokensAfter
  entry.summarizedToolResults += tail.summarizedToolResults
  entry.droppedItems += tail.droppedItems
  entry.reuseCount = 0

  return {
    items,
    tokens: entry.projectionTokens,
    appendedCount: appended.length,
    appendedTokens,
    appendedTokensAfter: tail.estimatedTokensAfter,
    previousProjectionTokens,
    summarizedToolResults: entry.summarizedToolResults,
    droppedItems: entry.droppedItems,
    reuseCountBeforeExtension,
  }
}

// 简介：保存一次完整压缩产生的稳定投影；异常或未压缩结果会清空旧缓存。
export function replaceProjection(
  cache: CompactionProjectionCache,
  factHistory: readonly ModelItem[],
  projection: {
    items: ModelItem[]
    compacted: boolean
    withinBudget: boolean
    estimatedTokensAfter: number
    summarizedToolResults: number
    droppedItems: number
  },
): void {
  cache.entry = projection.compacted && projection.withinBudget
    ? {
        source: factHistory.slice(),
        projection: projection.items,
        projectionTokens: projection.estimatedTokensAfter,
        summarizedToolResults: projection.summarizedToolResults,
        droppedItems: projection.droppedItems,
        reuseCount: 0,
      }
    : undefined
}

export function incrementProjectionReuse(cache: CompactionProjectionCache): CompactionProjectionEntry | undefined {
  const entry = cache.entry
  if (entry) entry.reuseCount += 1
  return entry
}
