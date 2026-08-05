import { appendItem } from '../state/sessionWriters'
import { readCheckpointState } from '../state/checkpointKind'
import { updateCheckpoint } from '../state/checkpointWriters'
import { checkpointsAtom, runAtom, itemsAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/transientAtoms'
import type { RunRecoverySnapshot } from '../state/checkpoint.type'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import { newId } from './newId'
import { userMessageLabel } from '@web-agent/ai'

/** Returns the conversation slice that belongs to the active user turn. */
export function currentTurnItems(sessionId: string, core: CoreInstance) {
  const store = core.getSessionStore(sessionId).store
  const items = store.getter(itemsAtom)
  const turnId = store.getter(runAtom)?.turnId
  if (turnId) {
    const anchoredStart = items.findIndex((entry) => entry.id === turnId)
    if (anchoredStart >= 0) return items.slice(anchoredStart)
  }
  let start = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') {
      start = index
      break
    }
  }
  return items.slice(start)
}

/** Gets the user input used for checkpoint labels without reading older turns. */
export function latestUserInput(sessionId: string, core: CoreInstance): string {
  const first = currentTurnItems(sessionId, core)[0]?.item
  return first?.role === 'user' ? userMessageLabel(first.content) : ''
}

/** Captures only recoverable run state; transient execution ids are never persisted. */
export function currentRunRecoverySnapshot(
  sessionId: string,
  runId: string,
  core: CoreInstance,
): RunRecoverySnapshot | undefined {
  const store = core.getSessionStore(sessionId).store
  const run = store.getter(runAtom)
  if (
    run?.runId !== runId
    || !['running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval'].includes(run.status)
  ) return undefined
  return {
    run: { ...run, pendingExecutionId: undefined },
    queuedUserMessages: store.getter(queuedUserMessagesAtom),
  }
}

/** Updates the working checkpoint when a queued message changes recoverable state. */
export function persistCurrentRunRecovery(
  sessionId: string,
  core: CoreInstance = defaultCore,
): void {
  const store = core.getSessionStore(sessionId).store
  const run = store.getter(runAtom)
  if (!run) return
  const recovery = currentRunRecoverySnapshot(sessionId, run.runId, core)
  if (!recovery) return
  const checkpoints = store.getter(checkpointsAtom)
  const latest = checkpoints[checkpoints.length - 1]
  if (
    !latest || readCheckpointState(latest).kind !== 'working'
    || latest.recovery?.run.runId !== run.runId
  ) return
  updateCheckpoint(sessionId, latest.turnIndex, latest.label, core, recovery, { kind: 'working' })
  const updated = store.getter(checkpointsAtom)[latest.turnIndex]
  if (updated) core.persistence.persistCheckpoint(sessionId, updated)
}

/** Finalizes the matching working checkpoint so a stopped run cannot revive on hydrate. */
export function persistStoppedRunCheckpoint(
  sessionId: string,
  runId: string,
  core: CoreInstance = defaultCore,
): void {
  const store = core.getSessionStore(sessionId).store
  const checkpoints = store.getter(checkpointsAtom)
  const latest = checkpoints[checkpoints.length - 1]
  if (
    !latest
    || readCheckpointState(latest).kind !== 'working'
    || latest.recovery?.run.runId !== runId
  ) return
  updateCheckpoint(
    sessionId,
    latest.turnIndex,
    `[已停止] ${latest.label.replace(/^\[执行中\]\s*/, '')}`,
    core,
    undefined,
    { kind: 'stopped' },
  )
  const updated = store.getter(checkpointsAtom)[latest.turnIndex]
  if (updated) core.persistence.persistCheckpoint(sessionId, updated)
}

/** Safely closes persisted calls whose execution ended without a saved result. */
export function closeUnresolvedToolCalls(sessionId: string, core: CoreInstance, interruption: string): void {
  const unresolved = new Map<string, { name: string; planStageId?: string }>()
  for (const entry of currentTurnItems(sessionId, core)) {
    if (entry.item.role === 'assistant') {
      for (const call of entry.item.tool_calls ?? []) {
        unresolved.set(call.id, { name: call.function.name, planStageId: entry.planStageId })
      }
    } else if (entry.item.role === 'tool') {
      unresolved.delete(entry.item.tool_call_id)
    }
  }
  for (const [callId, pending] of unresolved) {
    appendItem(sessionId, {
      id: newId(),
      createdAt: Date.now(),
      planStageId: pending.planStageId,
      item: {
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify({
          error: `${interruption}时工具 ${pending.name} 尚未保存结果；为避免重复副作用，本次未自动重试。请检查当前状态后再决定是否重新调用。`,
          interrupted: true,
          result: 'unknown',
        }),
      },
    }, core)
  }
}
