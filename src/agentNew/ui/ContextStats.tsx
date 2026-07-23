// 最近一次 LLM 请求的上下文统计（临时 UI 态，不进 messages/checkpoint）。
// ---------------------------------------------------------------------------
// 只读 contextStatsAtom：发送前显示估算 tokens；响应后若 provider 返回 usage，则显示真实 usage。

import { useAtomValue } from '@einfach/react'
import { contextStatsAtom, type ContextStatsSnapshot } from '@web-agent/core/state/transientAtoms'

const numberFormatter = new Intl.NumberFormat('en-US')

function fmt(value: number | undefined): string {
  return typeof value === 'number' ? numberFormatter.format(value) : '-'
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

export function ContextStats() {
  const stats = useAtomValue(contextStatsAtom)
  if (!stats) return null

  const summary = hasUsage(stats)
    ? `上下文 prompt ${fmt(stats.usage?.promptTokens)} · total ${fmt(stats.usage?.totalTokens)}`
    : `上下文估算 ${fmt(stats.estimatedTokens)} tokens`

  return (
    <details className="agentnew-context-stats" aria-label="上下文统计">
      <summary className="agentnew-context-stats-summary">
        <span>{summary}</span>
        <span>tools {fmt(stats.toolsCount)}</span>
      </summary>
      <div className="agentnew-context-stats-body">
        <div className="agentnew-context-stats-grid">
          <span>模型</span>
          <strong>{`${stats.vendor}/${stats.model}`}</strong>
          <span>轮次</span>
          <strong>{fmt(stats.llmTurn)}</strong>
          <span>估算 tokens</span>
          <strong>{fmt(stats.estimatedTokens)}</strong>
          <span>usage</span>
          <strong>
            {hasUsage(stats)
              ? `prompt ${fmt(stats.usage?.promptTokens)} / completion ${fmt(
                  stats.usage?.completionTokens,
                )} / total ${fmt(stats.usage?.totalTokens)}`
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
