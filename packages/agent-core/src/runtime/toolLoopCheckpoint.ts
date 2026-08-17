import type { CheckpointState } from '../state/checkpoint.type'
import { readCheckpointState } from '../state/checkpointKind'
import { commitCheckpoint, updateCheckpoint } from '../state/checkpointWriters'
import { checkpointsAtom, runAtom } from '../state/sessionAtoms'
import type { CoreInstance } from './core/coreInstance'
import { isCurrentRun } from './shared/runGuards'

export interface ToolLoopCheckpointWriter {
  persistWorkingTurn(): void
  commitTurn(state?: CheckpointState, label?: string): void
  commitStoppedTurn(): void
}

/** Maintains the checkpoint that represents one active user turn. */
export function createToolLoopCheckpointWriter(input: {
  id: string
  runId: string
  labelInput: string
  core: CoreInstance
  guard: Parameters<typeof isCurrentRun>[0]
  traceEvent(name: string, attrs?: Record<string, unknown>): void
  isRunning(): boolean
  resumeExisting?: boolean
}): ToolLoopCheckpointWriter {
  let workingTurnIndex: number | undefined
  const checkpoints = input.core.getSessionStore(input.id).store.getter(checkpointsAtom)
  const latest = checkpoints[checkpoints.length - 1]
  if (input.resumeExisting && latest && readCheckpointState(latest).kind === 'working') {
    workingTurnIndex = latest.turnIndex
  }
  const persistSnapshot = (label: string, state: CheckpointState) => {
    if (!isCurrentRun(input.guard)) return
    if (workingTurnIndex === undefined) {
      commitCheckpoint(input.id, label, input.core, state)
      const updatedCheckpoints = input.core.getSessionStore(input.id).store.getter(checkpointsAtom)
      workingTurnIndex = updatedCheckpoints[updatedCheckpoints.length - 1]?.turnIndex
    } else updateCheckpoint(input.id, workingTurnIndex, label, input.core, state)
    const checkpoint = workingTurnIndex === undefined ? undefined : input.core.getSessionStore(input.id).store.getter(checkpointsAtom)[workingTurnIndex]
    if (checkpoint) {
      input.traceEvent('checkpoint.persist', { turnIndex: checkpoint.turnIndex, items_count: checkpoint.items.length, working: state.kind === 'working' })
      input.core.persistence.persistCheckpoint(input.id, checkpoint)
    }
  }
  return {
    persistWorkingTurn: () => persistSnapshot(input.labelInput.slice(0, 20), { kind: 'working' }),
    commitTurn: (state = { kind: 'completed' }, label = input.labelInput.slice(0, 20)) => {
      if (!isCurrentRun(input.guard)) return
      persistSnapshot(label, state)
      const checkpoint = workingTurnIndex === undefined ? undefined : input.core.getSessionStore(input.id).store.getter(checkpointsAtom)[workingTurnIndex]
      if (checkpoint) input.traceEvent('checkpoint.commit', { turnIndex: checkpoint.turnIndex, items_count: checkpoint.items.length })
      input.core.persistence.persistSessions()
    },
    commitStoppedTurn: () => {
      const run = input.core.getSessionStore(input.id).store.getter(runAtom)
      if (run?.runId === input.runId && run.status === 'stopped') {
        persistSnapshot(`[已停止] ${input.labelInput.slice(0, 20)}`, { kind: 'stopped' })
      }
    },
  }
}
