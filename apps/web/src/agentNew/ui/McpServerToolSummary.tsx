// 卡片页脚左侧那一格：这个服务有多少工具。
//
// 【为什么要分两种说法】连上的服务说的是【当前事实】——工具已经真真切切注册进 ToolRegistry
// 了，数字来自这一刻的连接。没连上的服务只有【历史】：上次探测到什么样。两者共用一句
// 「N 个工具」就会把「上次探测到 3 个」读成「现在有 3 个可用工具」，而未连接服务的
// server.toolCount 恒为 0——照原样显示就是一句「0 个工具」的假话。
//
// 所以：连上 → 当前工具数；没连上 → 上次已知（措辞见 mcpLastKnownToolsText.ts）。两者
// 互斥，永不同时出现。

import type { McpServerView } from '../../mcp/types'
import { Trans } from '@lingui/react/macro'
import { describeLastKnownTools, formatProbedAtExact } from './mcpLastKnownToolsText'

export function McpServerToolSummary({ server }: { server: McpServerView }) {
  if (server.status === 'connected') {
    return <span><Trans>{server.toolCount} 个工具</Trans></span>
  }
  const lastKnown = server.lastKnownTools
  return (
    <span title={lastKnown ? formatProbedAtExact(lastKnown.cachedAt) : undefined}>
      {describeLastKnownTools(lastKnown)}
    </span>
  )
}
