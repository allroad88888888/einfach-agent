// RecoverySnapshotV1 与 session store allowlist 的单向投影。

import { atom, type Store } from '@einfach/core'
import { EMPTY_EXECUTION_GRAPH, executionGraphAtom } from '../execution/graph'
import { decodeRecoverySnapshot } from './recoverySnapshot.codec'
import { SESSION_SLOTS, SESSION_SLOT_KEYS } from './sessionSlots'
import {
  RECOVERY_SNAPSHOT_COMMIT_MARKER,
  RECOVERY_SNAPSHOT_SCHEMA_VERSION,
  type RecoverableRunState,
  type RecoveryAtomProjectionV1,
  type RecoverySessionMetaV1,
  type RecoverySnapshotV1,
} from './recoverySnapshot.type'
import {
  contextCheckpointAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from './sessionAtoms'
import {
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'
import { sessionsAtom } from './rootAtoms'
import type { RunState, SessionMeta } from './core.type'
import { projectStaticSessionMeta as projectSessionMeta } from './sessionMetaProjection'

export interface RecoverySnapshotCaptureOptions {
  /** session 内容所在 store 之外的唯一 root 会话登记表。 */
  rootStore: Store
  sessionId: string
  generation: number
  capturedAt?: number
}

function jsonClone<Value>(value: Value): Value {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Recovery projection must be JSON serializable')
  return JSON.parse(serialized) as Value
}

function cloneValidatedSnapshot(value: unknown, errorMessage: string): RecoverySnapshotV1 {
  const validated = decodeRecoverySnapshot(value)
  if (!validated) throw new Error(errorMessage)
  const cloned = decodeRecoverySnapshot(jsonClone(validated))
  if (!cloned) throw new Error('Validated recovery snapshot changed during JSON clone')
  return cloned
}

function withoutPendingExecutionId(run: RunState | undefined): RecoverableRunState | null {
  if (run === undefined) return null
  const { pendingExecutionId: _processLocalExecutionId, ...recoverableRun } = run
  return recoverableRun as RecoverableRunState
}

function projectStaticSessionMeta(session: SessionMeta): RecoverySessionMetaV1 {
  return projectSessionMeta(session)
}

/**
 * 同步读取 allowlist 的同一 JS 执行 epoch；读取结束前没有 await 或外部排队点。
 * JSON clone 隔离持久化 writer 与 atom 中可变引用，再用既有 codec 关闭验证边界。
 */
export function captureRecoverySnapshot(
  store: Store,
  options: RecoverySnapshotCaptureOptions,
): RecoverySnapshotV1 {
  const run = store.getter(runAtom)
  const session = options.rootStore.getter(sessionsAtom)[options.sessionId]
  if (!session) throw new Error(`Cannot capture recovery for an unregistered session: ${options.sessionId}`)
  const candidate = {
    schemaVersion: RECOVERY_SNAPSHOT_SCHEMA_VERSION,
    sessionId: options.sessionId,
    capturedAt: options.capturedAt ?? Date.now(),
    generation: options.generation,
    commitMarker: RECOVERY_SNAPSHOT_COMMIT_MARKER,
    session: projectStaticSessionMeta(session),
    values: {
      conversation: {
        items: store.getter(itemsAtom),
        contextCheckpoint: store.getter(contextCheckpointAtom) ?? null,
      },
      plan: {
        current: store.getter(planAtom) ?? null,
        stageCheckpoints: store.getter(planStageCheckpointsAtom),
      },
      run: withoutPendingExecutionId(run),
      queuedUserMessages: store.getter(queuedUserMessagesAtom),
      pendingQuestionAnswers: store.getter(pendingQuestionAnswersAtom),
      pendingArtifacts: store.getter(pendingArtifactsAtom),
      executionGraph: store.getter(executionGraphAtom),
      subagentContinuations: store.getter(subagentContinuationsAtom),
    },
  }
  return cloneValidatedSnapshot(candidate, 'Recovery projection does not satisfy RecoverySnapshotV1')
}

// A writable atom scopes all inner writes to one Einfach flush. It has no business value of
// its own: RecoverySnapshot remains a serialized projection rather than a second state source.
const applyRecoveryProjectionAtom = atom<null, [RecoveryAtomProjectionV1], void>(
  null,
  (_get, set, values) => {
    set(itemsAtom, values.conversation.items)
    set(contextCheckpointAtom, values.conversation.contextCheckpoint ?? undefined)
    set(planAtom, values.plan.current ?? undefined)
    set(planStageCheckpointsAtom, values.plan.stageCheckpoints)
    set(runAtom, values.run ?? undefined)
    set(queuedUserMessagesAtom, values.queuedUserMessages)
    set(pendingQuestionAnswersAtom, values.pendingQuestionAnswers)
    set(pendingArtifactsAtom, values.pendingArtifacts)
    set(executionGraphAtom, values.executionGraph)
    set(subagentContinuationsAtom, values.subagentContinuations)
  },
)

// Hydration may reuse an existing session store, so every v1-owned slot must be
// pushed back to its default; UI-only and derived atoms stay put.
//
// 遍历 SESSION_SLOTS 而不是手写一串 set：手写那份是「加了 atom 忘了补一行」的经典漏点，
// 而漏掉的槽位会带着上一个会话的值活下来，且不报错。
const clearRecoveryProjectionAtom = atom<null, [], void>(
  null,
  (_get, set) => {
    for (const key of SESSION_SLOT_KEYS) SESSION_SLOTS[key].clear(set)
  },
)

/**
 * Atomically applies only durable recovery values. Derived and UI/process-local atoms are left
 * intact; their owners rebuild or clear them at their own lifecycle boundary.
 */
export function applyRecoverySnapshot(store: Store, value: RecoverySnapshotV1): void {
  const snapshot = cloneValidatedSnapshot(value, 'Cannot apply an invalid RecoverySnapshotV1')
  store.setter(applyRecoveryProjectionAtom, snapshot.values)
}

/** Clears the v1-owned live projection without touching checkpoint history. */
export function clearRecoveryProjection(store: Store): void {
  store.setter(clearRecoveryProjectionAtom)
}
