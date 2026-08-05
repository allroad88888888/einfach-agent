import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { checkpointsAtom, itemsAtom, runAtom } from '../../state/sessionAtoms'
import { setItems, setRun } from '../../state/sessionWriters'
import {
  clearQueuedUserMessages,
  pruneBrowserCardsAfter,
  pruneRuntimeTranscriptEventsAfter,
  setComposerDraft,
  setWithdrawnTurnNotice,
} from '../../state/transientAtoms'
import { jumpToCheckpoint, rewindBeforeCheckpoint, updateCheckpoint } from '../../state/checkpointWriters'
import { readCheckpointState } from '../../state/checkpointKind'
import { defaultCore, type CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { persistTruncate } from '../persistenceBridge'
import { assertRunStatus } from './runCommands'
import { currentTurnHasSideEffects, currentTurnStartIndex } from './turnSafety'
import { userMessageText } from '@web-agent/ai'
import {
  captureUserContentReachability,
  disposeUserContentAfterMutation,
} from '../userContentDisposal'
import { cancelSessionSubmissions } from '../sessionSubmissionGate'

function persistCheckpointTruncation(core: CoreInstance, id: string, turnIndex: number): void {
  if (core === defaultCore) persistTruncate(id, turnIndex)
  else core.persistence.persistTruncate(id, turnIndex)
}

/** Builds transcript checkpoint and draft-rewind commands bound to one runtime core. */
export function createCheckpointCommands(core: CoreInstance, stopRun: () => void) {
  function revertToTurn(turnIndex: number): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const checkpoints = core.getSessionStore(id).store.getter(checkpointsAtom)
    if (turnIndex < 0 || turnIndex >= checkpoints.length) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    cancelSessionSubmissions(core, id)
    const before = captureUserContentReachability(core, id)
    core.abort.abortRun(id)
    jumpToCheckpoint(id, turnIndex, core)
    setRun(id, undefined, core)
    clearQueuedUserMessages(id, core)
    const checkpoint = checkpoints[turnIndex]
    const state = readCheckpointState(checkpoint)
    const stoppedWorkingCheckpoint = state.kind === 'working'
    updateCheckpoint(
      id,
      turnIndex,
      stoppedWorkingCheckpoint
        ? `[已停止] ${checkpoint.label.replace(/^\[执行中\]\s*/, '')}`
        : checkpoint.label,
      core,
      undefined,
      stoppedWorkingCheckpoint ? { kind: 'stopped' } : state,
    )
    const updatedCheckpoint = core.getSessionStore(id).store.getter(checkpointsAtom)[turnIndex]
    if (updatedCheckpoint) core.persistence.persistCheckpoint(id, updatedCheckpoint)
    pruneBrowserCardsAfter(id, checkpoints[turnIndex].createdAt, core)
    pruneRuntimeTranscriptEventsAfter(id, checkpoints[turnIndex].createdAt, core)
    persistCheckpointTruncation(core, id, turnIndex)
    disposeUserContentAfterMutation(core, before, {
      sessionId: id,
      reason: 'history_truncated',
      settings: { ...meta.settings },
    })
  }

  function revertTurnToDraft(turnIndex: number): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    const checkpoint = store.getter(checkpointsAtom)[turnIndex]
    if (!checkpoint) return
    const userIndex = currentTurnStartIndex(checkpoint.items)
    const targetUser = checkpoint.items[userIndex]
    if (!targetUser || targetUser.item.role !== 'user') return
    const currentItems = store.getter(itemsAtom)
    const currentUserIndex = currentItems.findIndex((item) => item.id === targetUser.id)
    const discardedItems = currentUserIndex >= 0
      ? currentItems.slice(currentUserIndex)
      : checkpoint.items.slice(userIndex)
    const sideEffects = currentTurnHasSideEffects(discardedItems)
    stopRun()
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const before = captureUserContentReachability(core, id)
    rewindBeforeCheckpoint(id, turnIndex, core)
    setRun(id, undefined, core)
    clearQueuedUserMessages(id, core)
    setComposerDraft(id, userMessageText(targetUser.item.content), core)
    pruneBrowserCardsAfter(id, targetUser.createdAt - 1, core)
    pruneRuntimeTranscriptEventsAfter(id, targetUser.createdAt - 1, core)
    setWithdrawnTurnNotice(id, {
      id: newId(), createdAt: Date.now(), sideEffects,
      text: sideEffects
        ? '已回退到该轮之前，原输入已放回输入框；已触发过工具，外部副作用不会被自动撤销。'
        : '已回退到该轮之前，原输入已放回输入框。',
    }, core)
    persistCheckpointTruncation(core, id, turnIndex - 1)
    disposeUserContentAfterMutation(core, before, {
      sessionId: id,
      reason: 'history_truncated',
      settings: { ...meta.settings },
    })
  }

  function withdrawCurrentTurnToDraft(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    if (!assertRunStatus(store.getter(runAtom), 'stopped')) return
    const items = store.getter(itemsAtom)
    const start = currentTurnStartIndex(items)
    if (start < 0 || items[start].item.role !== 'user') return
    const user = items[start].item
    for (let index = store.getter(checkpointsAtom).length - 1; index >= 0; index -= 1) {
      const checkpoint = store.getter(checkpointsAtom)[index]
      const userIndex = currentTurnStartIndex(checkpoint.items)
      if (checkpoint.items[userIndex]?.id === items[start].id) return revertTurnToDraft(checkpoint.turnIndex)
    }
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    cancelSessionSubmissions(core, id)
    const before = captureUserContentReachability(core, id)
    core.abort.abortRun(id)
    const sideEffects = currentTurnHasSideEffects(items.slice(start))
    const cutoffCreatedAt = items[start].createdAt
    setItems(id, items.slice(0, start), core)
    setRun(id, undefined, core)
    clearQueuedUserMessages(id, core)
    setComposerDraft(id, userMessageText(user.content), core)
    pruneBrowserCardsAfter(id, cutoffCreatedAt - 1, core)
    pruneRuntimeTranscriptEventsAfter(id, cutoffCreatedAt - 1, core)
    setWithdrawnTurnNotice(id, {
      id: newId(), createdAt: Date.now(), sideEffects,
      text: sideEffects
        ? '已撤回本轮对话并放回输入框；本轮已触发过工具，外部副作用不会被自动撤销。'
        : '已撤回本轮对话并放回输入框。',
    }, core)
    disposeUserContentAfterMutation(core, before, {
      sessionId: id,
      reason: 'history_truncated',
      settings: { ...meta.settings },
    })
  }

  return { revertToTurn, revertTurnToDraft, withdrawCurrentTurnToDraft }
}
