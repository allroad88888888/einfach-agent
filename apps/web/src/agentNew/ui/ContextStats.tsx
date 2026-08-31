// 最近一次 LLM 请求的上下文统计（会话瞬态，不进 messages/checkpoint）。
// ---------------------------------------------------------------------------
// 读 contextStatsAtom（agent store）：发送前显示估算 tokens；响应后若 provider 返回 usage，
// 则显示真实 usage。
//
// 「本次运行累计命中」只能由本组件补：它要异步读观测库，core 发请求那一刻拿不到。补的动作走
// applyRecoveredCacheTotals 命令 —— 以前这里是 `useAtom(contextStatsAtom)` 就地写，那是渲染层
// 直接写会话 atom，绕过收口点；stale guard 现在在写入器里，见 state/sessionTransientMutations.ts。

import { useEffect } from 'react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { recoverCacheTotalsFromTrace } from '@einfach-agent/core/observability'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  COST_SOFT_CAP_TOKENS,
  applyRecoveredCacheTotals,
  contextInputBudgetTokens,
  contextStatsAtom,
  type ContextStatsSnapshot,
} from '@einfach-agent/core'

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

function currentContextTokens(stats: ContextStatsSnapshot): number {
  return stats.usage?.promptTokens ?? stats.estimatedTokens
}

function displayedCacheRate(stats: ContextStatsSnapshot): number | undefined {
  return stats.cacheTotals?.hitRate ?? stats.usage?.cacheHitRate
}

export function ContextStats() {
  const { t } = useLingui()
  const stats = useAgentAtomValue(contextStatsAtom)
  const cacheTotalsRunId = stats?.cacheTotals?.runId

  useEffect(() => {
    if (!stats?.cacheTotals || cacheTotalsRunId === stats.runId) return undefined
    let current = true
    void recoverCacheTotalsFromTrace(stats.runId)
      .then((cacheTotals) => {
        if (!current || !cacheTotals) return
        applyRecoveredCacheTotals(stats.runId, cacheTotals)
      })
      .catch(() => {})
    return () => { current = false }
  }, [cacheTotalsRunId, stats?.cacheTotals, stats?.runId])

  if (!stats) return null

  const toolNames = (): string => stats.toolNames.length > 0 ? stats.toolNames.join(', ') : t`无`
  const cacheUsage = (): string => {
    const metricsStatus = stats.cache?.metricsStatus
    if (metricsStatus === 'pending') return t`等待本轮 Provider usage`
    if (metricsStatus === 'request_failed') return t`请求失败，未获得缓存指标`
    if (metricsStatus === 'cancelled') return t`请求已取消，未获得缓存指标`
    if (
      metricsStatus !== 'available'
      || typeof stats.usage?.cacheHitTokens !== 'number'
      || typeof stats.usage?.cacheMissTokens !== 'number'
    ) return t`Provider 未返回缓存指标`

    const missSource = stats.usage.cacheMissSource ?? 'unknown'
    const write = typeof stats.usage.cacheWriteTokens === 'number'
      ? ` / write ${fmt(stats.usage.cacheWriteTokens)}`
      : ''
    return `hit ${fmt(stats.usage.cacheHitTokens)} / miss ${fmt(
      stats.usage.cacheMissTokens,
    )} (${missSource})${write} / rate ${fmtRate(stats.usage.cacheHitRate)}`
  }
  const cacheTotals = (): string => {
    if (!stats.cacheTotals) return t`暂无`
    return `${fmt(stats.cacheTotals.measuredRequests)} requests / hit ${fmt(
      stats.cacheTotals.hitTokens,
    )} / miss ${fmt(stats.cacheTotals.missTokens)} / rate ${fmtRate(stats.cacheTotals.hitRate)}`
  }
  const longSessionWarning = (): string | undefined => {
    const before = stats.estimatedTokensBeforeCompaction
    if (typeof before !== 'number' || before <= COST_SOFT_CAP_TOKENS) return undefined
    return t`本轮压缩前约 ${fmt(before)} tokens，已超过 ${fmt(COST_SOFT_CAP_TOKENS)} 的会话软上限；建议新开会话。`
  }

  const currentTokens = currentContextTokens(stats)
  // 使用运行时实际输入预算，而非供应商标称窗口（例如 DeepSeek V4 的 1M）。
  // 旧快照没有该字段时按同一套本地默认预算回退。
  const maxContextTokens = stats.inputBudgetTokens
    ?? contextInputBudgetTokens(stats.vendor, stats.model)
  const contextPercentage = Math.round((currentTokens / maxContextTokens) * 100)
  const sessionWarning = longSessionWarning()
  const summary = sessionWarning
    ? t`上下文 ${contextPercentage}% · 建议新开会话`
    : t`上下文 ${contextPercentage}%`

  return (
    <details className="agentnew-context-stats" aria-label={t`上下文统计`}>
      <summary className="agentnew-context-stats-summary">
        <span>{summary}</span>
        {typeof displayedCacheRate(stats) === 'number' ? (
          <span>run cache {fmtRate(displayedCacheRate(stats))}</span>
        ) : null}
        <span>tools {fmt(stats.toolsCount)}</span>
      </summary>
      <div className="agentnew-context-stats-body">
        <div className="agentnew-context-stats-grid">
          <span><Trans>模型</Trans></span>
          <strong>{`${stats.vendor}/${stats.model}`}</strong>
          <span><Trans>估算 tokens</Trans></span>
          <strong>{fmt(stats.estimatedTokens)}</strong>
          {sessionWarning ? (
            <>
              <span><Trans>会话建议</Trans></span>
              <strong>{sessionWarning}</strong>
            </>
          ) : null}
          <span><Trans>上下文占用</Trans></span>
          <strong>
            {fmt(currentTokens)} / {fmt(maxContextTokens)} tokens ({contextPercentage}%)
          </strong>
          <span><Trans>计算基数</Trans></span>
          <strong><Trans>本次可用输入额度（已扣除输出预留与安全余量）</Trans></strong>
          <span>usage</span>
          <strong>
            {hasUsage(stats)
              ? `prompt ${fmt(stats.usage?.promptTokens)} / completion ${fmt(
                  stats.usage?.completionTokens,
                )} / total ${fmt(stats.usage?.totalTokens)}`
              : t`暂无`}
          </strong>
          <span><Trans>本轮缓存命中</Trans></span>
          <strong>{cacheUsage()}</strong>
          <span><Trans>本次运行累计命中</Trans></span>
          <strong>{cacheTotals()}</strong>
          <span><Trans>请求投影档案（本地）</Trans></span>
          <strong title={stats.cache?.profileId}>
            {stats.cache
              ? `${stats.cache.lane} / epoch ${stats.cache.epoch} (${stats.cache.epochReason}) / ${
                  stats.cache.compactionBoundary
                }`
              : t`暂无`}
          </strong>
          <span><Trans>缓存口径</Trans></span>
          <strong><Trans>DeepSeek 无显式 cache_id；命中以本轮 Provider usage 为准</Trans></strong>
          <span>chars</span>
          <strong>
            total {fmt(stats.totalChars)} / messages {fmt(stats.messagesChars)} / tools {fmt(stats.toolsChars)}
          </strong>
          <span>tools</span>
          <strong title={toolNames()}>{toolNames()}</strong>
        </div>
      </div>
    </details>
  )
}
