import {
  AgentHistoryError,
  type AgentHistorySearchHit,
  type AgentHistoryWarning,
} from '@einfach-agent/core/history'

export interface LegacyHistoryContinuation {
  readonly indexSnapshot: string
  /** Stable key of the last entry already consumed; resume is exclusive. */
  readonly lastRunAgentKey: string
  readonly directory?: {
    readonly runKey: string
    readonly checkedOffset: number
    readonly snapshot: string
  }
}

export interface LegacyHistoryPage<Record> {
  readonly records: readonly Record[]
  readonly warnings: readonly AgentHistoryWarning[]
  readonly truncated: boolean
  readonly continuation?: LegacyHistoryContinuation
}

export function assertLegacyDirectorySnapshot(expected: string, current: string): void {
  if (expected !== current) {
    throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'Legacy trace directory changed after the cursor was issued.')
  }
}

export interface LegacyHistorySearchResult {
  readonly hits: readonly AgentHistorySearchHit[]
  readonly warnings: readonly AgentHistoryWarning[]
  readonly truncated: boolean
  readonly continuation?: LegacyHistoryContinuation
}

export function assertLegacyContinuationSnapshot(
  continuation: LegacyHistoryContinuation | undefined,
  currentSnapshot: string | undefined,
): void {
  if (continuation && continuation.indexSnapshot !== currentSnapshot) {
    throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'Legacy history index changed after the cursor was issued.')
  }
}
