// 每个 session 的恢复快照写入器：同步捕获、串行 CAS、删除 fence。

import type { Store } from '@einfach/core'
import type { AgentRolloutDriver } from '../history'
import type { ObservabilityPort } from '../observability/port'
import { captureRecoverySnapshot } from '../state/recoveryProjection'
import type { RecoveryDriver } from '../state/persistence/recoveryDriver'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import {
  createAgentRolloutCoordinator,
  type AgentRolloutCoordinator,
} from './agentRolloutCoordinator'

const MAX_STALE_RETRIES = 3

type RecoveryWriterObservability = Pick<ObservabilityPort, 'beginPerformanceDiagnostic'>

export type RecoveryWriteOutcome =
  | { status: 'saved'; sessionId: string; generation: number; attempts: number }
  | { status: 'tombstoned'; sessionId: string }
  | { status: 'skipped'; sessionId: string; reason: 'reset' }
  | { status: 'error'; sessionId: string; error: unknown }

export type RecoveryDeleteOutcome =
  | { status: 'deleted'; sessionId: string }
  | { status: 'error'; sessionId: string; error: unknown }

export interface RecoveryWriter {
  /** Captures atom state synchronously, then persists that immutable capture behind this session's queue. */
  persist(store: Store, sessionId: string, reason?: string): Promise<RecoveryWriteOutcome>
  /** Closes the local write gate before durably writing the driver's terminal tombstone. */
  deleteSession(sessionId: string): Promise<RecoveryDeleteOutcome>
  /** Waits for writes already queued when called; callers can use it before orderly shutdown. */
  flush(): Promise<void>
  /** Discards queued writes from this writer lifecycle; it never reuses a deleted session id. */
  reset(): void
}

export interface RecoveryWriterOptions {
  /** Core root store supplies the registered static session metadata captured with recovery state. */
  rootStore: Store
  recovery: RecoveryDriver
  observability: RecoveryWriterObservability
  agentRollout?: AgentRolloutDriver
}

interface SessionWriteState {
  tail: Promise<void>
  epoch: number
  nextGeneration: number
  acknowledgedGeneration?: number
  tombstoned: boolean
}

function isCurrent(
  state: SessionWriteState,
  captureEpoch: number,
  currentEpoch: number,
): boolean {
  return state.epoch === captureEpoch && captureEpoch === currentEpoch && !state.tombstoned
}

function withGeneration(snapshot: RecoverySnapshotV1, generation: number): RecoverySnapshotV1 {
  return { ...snapshot, generation }
}

function finish(
  operation: ReturnType<RecoveryWriterObservability['beginPerformanceDiagnostic']>,
  outcome: RecoveryWriteOutcome | RecoveryDeleteOutcome,
): void {
  try {
    operation.finish(
      outcome.status === 'error' ? 'error' : 'ok',
      {
        sessionId: outcome.sessionId,
        outcome: outcome.status,
        ...('generation' in outcome ? { generation: outcome.generation } : {}),
        ...('attempts' in outcome ? { attempts: outcome.attempts } : {}),
      },
      outcome.status === 'error' ? outcome.error : undefined,
    )
  } catch {
    // Observability is a side channel and cannot alter recovery durability.
  }
}

function enqueue<Outcome>(state: SessionWriteState, task: () => Promise<Outcome>): Promise<Outcome> {
  const run = () => Promise.resolve().then(task)
  const result = state.tail.then(run, run)
  state.tail = result.then(() => undefined, () => undefined)
  return result
}

/**
 * Owns no atom subscription. Callers explicitly choose persistence boundaries through persist().
 * A capture happens before its async task is enqueued, so later atom changes cannot alter it.
 */
export function createRecoveryWriter(options: RecoveryWriterOptions): RecoveryWriter {
  const states = new Map<string, SessionWriteState>()
  const newRolloutCoordinator = (): AgentRolloutCoordinator | undefined => options.agentRollout
    ? createAgentRolloutCoordinator(options.agentRollout)
    : undefined
  let rolloutCoordinator = newRolloutCoordinator()
  let epoch = 0

  function stateFor(sessionId: string): SessionWriteState {
    const existing = states.get(sessionId)
    if (existing && existing.epoch === epoch) return existing
    const state: SessionWriteState = {
      tail: Promise.resolve(),
      epoch,
      nextGeneration: 1,
      tombstoned: false,
    }
    states.set(sessionId, state)
    return state
  }

  async function saveCaptured(
    state: SessionWriteState,
    captured: RecoverySnapshotV1,
    sessionId: string,
    captureEpoch: number,
    captureCoordinator: AgentRolloutCoordinator | undefined,
  ): Promise<RecoveryWriteOutcome> {
    if (!isCurrent(state, captureEpoch, epoch)) {
      return state.tombstoned
        ? { status: 'tombstoned', sessionId }
        : { status: 'skipped', sessionId, reason: 'reset' }
    }
    // Rollout is the strong boundary: failures become an observable outcome and leave recovery untouched.
    try {
      await captureCoordinator?.capture(captured)
    } catch (error) {
      return { status: 'error', sessionId, error }
    }
    // A delete/reset may have raced the append; never retain that retired lifecycle as previous.
    if (!isCurrent(state, captureEpoch, epoch)) captureCoordinator?.resetSession(sessionId)

    try {
      for (let attempt = 1; attempt <= MAX_STALE_RETRIES + 1; attempt += 1) {
        if (!isCurrent(state, captureEpoch, epoch)) {
          return state.tombstoned
            ? { status: 'tombstoned', sessionId }
            : { status: 'skipped', sessionId, reason: 'reset' }
        }

        const latest = await options.recovery.loadLatest(sessionId)
        if (!isCurrent(state, captureEpoch, epoch)) {
          return state.tombstoned
            ? { status: 'tombstoned', sessionId }
            : { status: 'skipped', sessionId, reason: 'reset' }
        }

        const generation = Math.max(
          captured.generation,
          (latest?.generation ?? -1) + 1,
          state.acknowledgedGeneration === undefined ? 0 : state.acknowledgedGeneration + 1,
        )
        state.nextGeneration = Math.max(state.nextGeneration, generation + 1)
        const result = await options.recovery.saveLatest(
          sessionId,
          withGeneration(captured, generation),
        )

        if (result.status === 'saved') {
          state.acknowledgedGeneration = result.generation
          return { status: 'saved', sessionId, generation: result.generation, attempts: attempt }
        }
        if (result.status === 'tombstoned') {
          state.tombstoned = true
          return { status: 'tombstoned', sessionId }
        }
        // A stale result never becomes acknowledged. Re-read the durable generation before retrying.
      }
      return {
        status: 'error',
        sessionId,
        error: new Error(`Recovery write remained stale after ${MAX_STALE_RETRIES + 1} attempts`),
      }
    } catch (error) {
      return { status: 'error', sessionId, error }
    }
  }

  function persist(store: Store, sessionId: string, reason?: string): Promise<RecoveryWriteOutcome> {
    const state = stateFor(sessionId)
    const operation = options.observability.beginPerformanceDiagnostic(
      'persistence.recovery.write',
      { sessionId, reason },
      { slowMs: 100 },
    )
    if (state.tombstoned) {
      const outcome: RecoveryWriteOutcome = { status: 'tombstoned', sessionId }
      finish(operation, outcome)
      return Promise.resolve(outcome)
    }

    let captured: RecoverySnapshotV1
    try {
      const generation = state.nextGeneration
      captured = captureRecoverySnapshot(store, {
        rootStore: options.rootStore,
        sessionId,
        generation,
      })
      state.nextGeneration += 1
    } catch (error) {
      const outcome: RecoveryWriteOutcome = { status: 'error', sessionId, error }
      finish(operation, outcome)
      return Promise.resolve(outcome)
    }

    const captureEpoch = epoch
    const captureCoordinator = rolloutCoordinator
    return enqueue(
      state,
      () => saveCaptured(state, captured, sessionId, captureEpoch, captureCoordinator),
    ).then((outcome) => {
      finish(operation, outcome)
      return outcome
    })
  }

  function deleteSession(sessionId: string): Promise<RecoveryDeleteOutcome> {
    const state = stateFor(sessionId)
    state.tombstoned = true
    rolloutCoordinator?.resetSession(sessionId)
    const operation = options.observability.beginPerformanceDiagnostic(
      'persistence.recovery.delete',
      { sessionId },
      { slowMs: 100 },
    )
    // Deletion intentionally ignores reset's epoch: once requested, its durable fence must still land.
    return enqueue<RecoveryDeleteOutcome>(state, async (): Promise<RecoveryDeleteOutcome> => {
      try {
        await options.recovery.deleteSession(sessionId)
        return { status: 'deleted', sessionId }
      } catch (error) {
        return { status: 'error', sessionId, error }
      }
    }).then((outcome) => {
      finish(operation, outcome)
      return outcome
    })
  }

  return {
    persist,
    deleteSession,
    async flush() {
      await Promise.all([...states.values()].map((state) => state.tail))
    },
    reset() {
      epoch += 1
      states.clear()
      rolloutCoordinator?.reset()
      rolloutCoordinator = newRolloutCoordinator()
    },
  }
}
