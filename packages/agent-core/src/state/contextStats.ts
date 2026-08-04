// 最近一次 LLM 请求的上下文统计快照：供 runtime 写入、UI 只读渲染。

export interface ContextRoleStats {
  count: number
  chars: number
  estimatedTokens: number
}

export interface ContextUsageStats {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  cacheMissSource?: 'provider' | 'derived' | 'unknown'
  cacheWriteTokens?: number
  cacheHitRate?: number
}

export interface ContextCacheStats {
  lane: 'main' | 'subagent' | 'evaluator' | 'distill:core' | 'distill:child_brief'
  profileId: string
  epoch: number
  epochReason:
    | 'initial'
    | 'profile_changed'
    | 'dynamic_control_changed'
    | 'history_inserted_before_dynamic_tail'
    | 'compaction_projection_changed'
    | 'request_projection_changed'
  protocolVersion: string
  toolSetFingerprint: string
  laneScopeFingerprint: string
  systemFingerprint: string
  requestProjectionFingerprint: string
  compactionBoundary: 'full-history' | 'compacted-history'
  metricsStatus: 'pending' | 'available' | 'unavailable' | 'request_failed' | 'cancelled'
}

export interface ContextCacheTotals {
  // 一个 run 内可能因工具集或压缩投影切换多个 cache epoch；累计值不能被这些边界清零。
  runId: string
  measuredRequests: number
  hitTokens: number
  missTokens: number
  hitRate?: number
}

export interface ContextStatsSnapshot {
  id: string
  createdAt: number
  vendor: string
  model: string
  runId: string
  turnId: string
  llmTurn: number
  messagesCount: number
  toolsCount: number
  systemChars: number
  messagesChars: number
  toolsChars: number
  totalChars: number
  estimatedTokens: number
  // 仅在本轮使用了压缩投影时记录；用于提示用户原始会话已超过成本软上限。
  estimatedTokensBeforeCompaction?: number
  // 本次请求实际可用的输入上下文额度：已按本地成本上限扣除了输出预留与安全余量。
  // 有值时 UI 必须用它做占用百分比的分母，不能拿 provider 标称窗口。
  inputBudgetTokens?: number
  roles: {
    system: ContextRoleStats
    user: ContextRoleStats
    assistant: ContextRoleStats
    tool: ContextRoleStats
  }
  toolNames: string[]
  usage?: ContextUsageStats
  cache?: ContextCacheStats
  cacheTotals?: ContextCacheTotals
  finishReason?: string | null
  responseModel?: string
}
