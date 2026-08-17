import { appendItem } from '../state/sessionWriters'
import { readCheckpointState } from '../state/checkpointKind'
import { updateCheckpoint } from '../state/checkpointWriters'
import { checkpointsAtom, runAtom, itemsAtom } from '../state/sessionAtoms'
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

/** Finalizes the matching working checkpoint so a stopped run cannot revive on hydrate. */
export function persistStoppedRunCheckpoint(
  sessionId: string,
  runId: string,
  core: CoreInstance = defaultCore,
): void {
  const store = core.getSessionStore(sessionId).store
  const run = store.getter(runAtom)
  const checkpoints = store.getter(checkpointsAtom)
  const latest = checkpoints[checkpoints.length - 1]
  if (
    run?.runId !== runId
    || run.status !== 'stopped'
    || !latest
    || readCheckpointState(latest).kind !== 'working'
  ) return
  updateCheckpoint(
    sessionId,
    latest.turnIndex,
    `[已停止] ${latest.label.replace(/^\[执行中\]\s*/, '')}`,
    core,
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
