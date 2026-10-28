import type { HistoryStackState } from '@einfach/core'
import type { ConversationItem } from './core.type'

export type SessionTurnHistoryBlockedReason = 'history_unavailable' | 'irreversible_barrier'

export interface SessionTurnHistoryItem {
  readonly userItem: ConversationItem
  readonly state: 'active' | 'retracted'
  readonly blocked?: SessionTurnHistoryBlockedReason
  readonly willStopRun?: boolean
}

export interface SessionTurnHistoryProjection {
  readonly turns: readonly SessionTurnHistoryItem[]
}

interface LoggedUserItem {
  readonly entryIndex: number
  readonly item: ConversationItem
}

function appendedUserItem(entry: HistoryStackState['entries'][number]): ConversationItem | undefined {
  for (const op of entry.ops) {
    if (op.key !== 'items:append') continue
    const item = op.after as ConversationItem | undefined
    if (item?.item.role === 'user') return item
  }
  return undefined
}

export function loggedUserItems(stack: HistoryStackState): readonly LoggedUserItem[] {
  const users: LoggedUserItem[] = []
  stack.entries.forEach((entry, entryIndex) => {
    const item = appendedUserItem(entry)
    if (item) users.push({ entryIndex, item })
  })
  return users
}

export function userItemEntryIndex(stack: HistoryStackState, itemId: string): number | undefined {
  return loggedUserItems(stack).find((entry) => entry.item.id === itemId)?.entryIndex
}

/** Cursor immediately after the selected turn, before the next user append. */
export function restoreCursorForUserItem(stack: HistoryStackState, itemId: string): number | undefined {
  const users = loggedUserItems(stack)
  const target = users.findIndex((entry) => entry.item.id === itemId)
  if (target < 0) return undefined
  return users[target + 1]?.entryIndex ?? stack.entries.length
}

export function projectSessionTurnHistory(
  stack: HistoryStackState,
  activeItems: readonly ConversationItem[],
  barrierTxId?: string,
  willStopRun = false,
): SessionTurnHistoryProjection {
  const activeUsers = activeItems.filter((item) => item.item.role === 'user')
  const logged = loggedUserItems(stack)
  const loggedById = new Map(logged.map((entry) => [entry.item.id, entry]))
  const barrierIndex = stack.entries.findIndex((entry) => entry.txId === barrierTxId)
  const activeTurns: SessionTurnHistoryItem[] = activeUsers.map((userItem) => {
    const target = loggedById.get(userItem.id)
    const blocked = !target
      ? 'history_unavailable' as const
      : barrierIndex >= target.entryIndex && barrierIndex < stack.cursor
        ? 'irreversible_barrier' as const
        : undefined
    return { userItem, state: 'active' as const, ...(blocked ? { blocked } : {}), ...(willStopRun ? { willStopRun: true } : {}) }
  })
  const retractedTurns = logged
    .filter(({ entryIndex }) => entryIndex >= stack.cursor)
    .map(({ item }) => ({ userItem: item, state: 'retracted' as const }))
  return { turns: [...activeTurns, ...retractedTurns] }
}
