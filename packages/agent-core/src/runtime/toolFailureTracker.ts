import type { ToolResult } from '../tools/types'
import { TOOL_FAILURE_ERROR_PREVIEW_LIMIT, TOOL_FAILURE_STREAK_THRESHOLD, toolFailureStreakNotice, type ToolFailureStreak } from './selfReflectionPrompts'

export interface PendingToolFailureNotice {
  text: string
  tools: Array<{ name: string; count: number }>
}

export interface ToolFailureTracker {
  record(name: string, result: ToolResult): void
  consume(): PendingToolFailureNotice | undefined
  reset(): void
}

/** Tracks consecutive per-tool execution failures for a single model run. */
export function createToolFailureTracker(): ToolFailureTracker {
  const streaks = new Map<string, ToolFailureStreak>()
  let pending: PendingToolFailureNotice | undefined
  const preview = (text: string) => text.length > TOOL_FAILURE_ERROR_PREVIEW_LIMIT ? `${text.slice(0, TOOL_FAILURE_ERROR_PREVIEW_LIMIT)}...` : text
  return {
    record(name: string, result: ToolResult): void {
      if ('pause' in result || result.ok) { streaks.delete(name); return }
      const count = (streaks.get(name)?.count ?? 0) + 1
      streaks.set(name, { count, lastError: preview(result.error) })
      if (count < TOOL_FAILURE_STREAK_THRESHOLD) return
      const failing = [...streaks.entries()].filter(([, streak]) => streak.count >= TOOL_FAILURE_STREAK_THRESHOLD)
      pending = { text: toolFailureStreakNotice(failing), tools: failing.map(([name, streak]) => ({ name, count: streak.count })) }
    },
    consume(): PendingToolFailureNotice | undefined { const next = pending; pending = undefined; return next },
    reset(): void { streaks.clear(); pending = undefined },
  }
}
