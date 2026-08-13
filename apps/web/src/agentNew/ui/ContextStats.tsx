// 最近一次 LLM 请求的上下文统计（临时 UI 态，不进 messages/checkpoint）。
// ---------------------------------------------------------------------------
// 读写 contextStatsAtom：发送前显示估算 tokens；响应后若 provider 返回 usage，则显示真实 usage。

import { useAtom } from '@einfach/react'
import { useEffect } from 'react'
import { recoverCacheTotalsFromTrace } from '@web-agent/core/observability'
import {
  COST_SOFT_CAP_TOKENS,
  contextInputBudgetTokens,
  contextStatsAtom,
  type ContextStatsSnapshot,
} from '@web-agent/core'

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

function displayedCacheRate(stats: ContextStatsSnapshot): number | undefined {
  return stats.cacheTotals?.hitRate ?? stats.usage?.cacheHitRate
}

function longSessionWarning(stats: ContextStatsSnapshot): string | undefined {
  const before = stats.estimatedTokensBeforeCompaction
  if (typeof before !== 'number' || before <= COST_SOFT_CAP_TOKENS) return undefined
  return `本轮压缩前约 ${fmt(before)} tokens，已超过 ${fmt(COST_SOFT_CAP_TOKENS)} 的会话软上限；建议新开会话。`
}

export function ContextStats() {
  const [stats, setStats] = useAtom(contextStatsAtom)
  const cacheTotalsRunId = stats?.cacheTotals?.runId

  useEffect(() => {
    if (!stats?.cacheTotals || cacheTotalsRunId === stats.runId) return undefined
    let current = true
    void recoverCacheTotalsFromTrace(stats.runId)
      .then((cacheTotals) => {
        if (!current || !cacheTotals) return
        setStats((previous) => (
          previous?.runId === stats.runId && previous.cacheTotals?.runId !== stats.runId
            ? { ...previous, cacheTotals }
            : previous
        ))
      })
      .catch(() => {})
    return () => { current = false }
  }, [cacheTotalsRunId, setStats, stats?.cacheTotals, stats?.runId])

  if (!stats) return null

  const currentTokens = currentContextTokens(stats)
  // 使用运行时实际输入预算，而非供应商标称窗口（例如 DeepSeek V4 的 1M）。
  // 旧快照没有该字段时按同一套本地默认预算回退。
  const maxContextTokens = stats.inputBudgetTokens
    ?? contextInputBudgetTokens(stats.vendor, stats.model)
  const contextPercentage = Math.round((currentTokens / maxContextTokens) * 100)
  const sessionWarning = longSessionWarning(stats)
  const summary = sessionWarning
    ? `上下文 ${contextPercentage}% · 建议新开会话`
    : `上下文 ${contextPercentage}%`

  return (
    <details className="agentnew-context-stats" aria-label="上下文统计">
      <summary className="agentnew-context-stats-summary">
        <span>{summary}</span>
        {typeof displayedCacheRate(stats) === 'number' ? (
          <span>run cache {fmtRate(displayedCacheRate(stats))}</span>
        ) : null}
        <span>tools {fmt(stats.toolsCount)}</span>
      </summary>
      <div className="agentnew-context-stats-body">
        <div className="agentnew-context-stats-grid">
          <span>模型</span>
          <strong>{`${stats.vendor}/${stats.model}`}</strong>
          <span>估算 tokens</span>
          <strong>{fmt(stats.estimatedTokens)}</strong>
          {sessionWarning ? (
            <>
              <span>会话建议</span>
              <strong>{sessionWarning}</strong>
            </>
          ) : null}
          <span>上下文占用</span>
          <strong>
            {fmt(currentTokens)} / {fmt(maxContextTokens)} tokens ({contextPercentage}%)
          </strong>
          <span>计算基数</span>
          <strong>本次可用输入额度（已扣除输出预留与安全余量）</strong>
          <span>usage</span>
          <strong>
            {hasUsage(stats)
              ? `prompt ${fmt(stats.usage?.promptTokens)} / completion ${fmt(
                  stats.usage?.completionTokens,
                )} / total ${fmt(stats.usage?.totalTokens)}`
              : '暂无'}
          </strong>
          <span>本轮缓存命中</span>
          <strong>{cacheUsage(stats)}</strong>
          <span>本次运行累计命中</span>
          <strong>{cacheTotals(stats)}</strong>
          <span>请求投影档案（本地）</span>
          <strong title={stats.cache?.profileId}>
            {stats.cache
              ? `${stats.cache.lane} / epoch ${stats.cache.epoch} (${stats.cache.epochReason}) / ${
                  stats.cache.compactionBoundary
                }`
              : '暂无'}
          </strong>
          <span>缓存口径</span>
          <strong>DeepSeek 无显式 cache_id；命中以本轮 Provider usage 为准</strong>
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
