// 最近一次 LLM 请求的上下文统计（临时 UI 态，不进 messages/checkpoint）。
// ---------------------------------------------------------------------------
// 只读 contextStatsAtom：发送前显示估算 tokens；响应后若 provider 返回 usage，则显示真实 usage。

import { useAtomValue } from '@einfach/react'
import { contextWindowTokens } from '@web-agent/core/runtime/core/plugins/compactionPlugin'
import { contextStatsAtom, type ContextStatsSnapshot } from '@web-agent/core/state/transientAtoms'

const numberFormatter = new Intl.NumberFormat('en-US')

function fmt(value: number | undefined): string {
  return typeof value === 'number' ? numberFormatter.format(value) : '-'
}

function fmtRate(value: number | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '-'
}

function hasUsage(stats: ContextStatsSnapshot): boolean {
  return (
    typeof stats.usage?.promptTokens === 'number' ||
    typeof stats.usage?.completionTokens === 'number' ||
    typeof stats.usage?.totalTokens === 'number'
  )
}

function toolNames(stats: ContextStatsSnapshot): string {
  return stats.toolNames.length > 0 ? stats.toolNames.join(', ') : '无'
}

function currentContextTokens(stats: ContextStatsSnapshot): number {
  return stats.usage?.promptTokens ?? stats.estimatedTokens
}

function cacheUsage(stats: ContextStatsSnapshot): string {
  const metricsStatus = stats.cache?.metricsStatus
  if (metricsStatus === 'pending') return '等待本轮 Provider usage'
  if (metricsStatus === 'request_failed') return '请求失败，未获得缓存指标'
  if (metricsStatus === 'cancelled') return '请求已取消，未获得缓存指标'
  if (
    metricsStatus !== 'available'
    || typeof stats.usage?.cacheHitTokens !== 'number'
    || typeof stats.usage?.cacheMissTokens !== 'number'
  ) {
    return 'Provider 未返回缓存指标'
  }

  const missSource = stats.usage.cacheMissSource ?? 'unknown'
  const write = typeof stats.usage.cacheWriteTokens === 'number'
    ? ` / write ${fmt(stats.usage.cacheWriteTokens)}`
    : ''
  return `hit ${fmt(stats.usage.cacheHitTokens)} / miss ${fmt(
    stats.usage.cacheMissTokens,
  )} (${missSource})${write} / rate ${fmtRate(stats.usage.cacheHitRate)}`
}

function cacheTotals(stats: ContextStatsSnapshot): string {
  if (!stats.cacheTotals) return '暂无'
  return `${fmt(stats.cacheTotals.measuredRequests)} requests / hit ${fmt(
    stats.cacheTotals.hitTokens,
  )} / miss ${fmt(stats.cacheTotals.missTokens)} / rate ${fmtRate(stats.cacheTotals.hitRate)}`
}

export function ContextStats() {
  const stats = useAtomValue(contextStatsAtom)
  if (!stats) return null

  const currentTokens = currentContextTokens(stats)
  const maxContextTokens = contextWindowTokens(stats.vendor, stats.model)
  const contextPercentage = Math.round((currentTokens / maxContextTokens) * 100)
  const summary = `上下文 ${contextPercentage}%`

  return (
    <details className="agentnew-context-stats" aria-label="上下文统计">
      <summary className="agentnew-context-stats-summary">
        <span>{summary}</span>
        {typeof stats.usage?.cacheHitRate === 'number' ? (
          <span>cache {fmtRate(stats.usage.cacheHitRate)}</span>
        ) : null}
        <span>tools {fmt(stats.toolsCount)}</span>
      </summary>
      <div className="agentnew-context-stats-body">
        <div className="agentnew-context-stats-grid">
          <span>模型</span>
          <strong>{`${stats.vendor}/${stats.model}`}</strong>
          <span>估算 tokens</span>
          <strong>{fmt(stats.estimatedTokens)}</strong>
          <span>上下文占用</span>
          <strong>
            {fmt(currentTokens)} / {fmt(maxContextTokens)} tokens ({contextPercentage}%)
          </strong>
          <span>usage</span>
          <strong>
            {hasUsage(stats)
              ? `prompt ${fmt(stats.usage?.promptTokens)} / completion ${fmt(
                  stats.usage?.completionTokens,
                )} / total ${fmt(stats.usage?.totalTokens)}`
              : '暂无'}
          </strong>
          <span>缓存命中</span>
          <strong>{cacheUsage(stats)}</strong>
          <span>当前档案累计</span>
          <strong>{cacheTotals(stats)}</strong>
          <span>缓存档案</span>
          <strong title={stats.cache?.profileId}>
            {stats.cache
              ? `${stats.cache.lane} / epoch ${stats.cache.epoch} (${stats.cache.epochReason}) / ${
                  stats.cache.compactionBoundary
                }`
              : '暂无'}
          </strong>
          <span>chars</span>
          <strong>
            total {fmt(stats.totalChars)} / messages {fmt(stats.messagesChars)} / tools {fmt(stats.toolsChars)}
          </strong>
          <span>tools</span>
          <strong title={toolNames(stats)}>{toolNames(stats)}</strong>
        </div>
      </div>
    </details>
  )
}
