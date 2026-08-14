import type { CoreInstance } from '../runtime/core/coreInstance'
import type { RecoveryWriteOutcome } from '../runtime/recoveryWriter'
import type { ChildAgentResult, DelegateAgentChildSpec, SubagentNodeRecord } from './types'
import {
  fenceChildContinuation,
  markChildContinuationTerminal,
  queueChildContinuations,
  type QueuedChildContinuationBatch,
} from './continuationStore'

export type { QueuedChildContinuationBatch } from './continuationStore'

export interface TerminalChildContinuation {
  childId: string
  kind: ChildAgentResult['status']
  summary: string
  resultArchivePath: string | undefined
  skillFiles: string[]
  skillIds: string[]
  changeSets: Array<{ id: string; reversible: boolean }>
}

/** Persists the child scheduling state at the two boundaries before child work can start. */
export async function persistQueuedChildContinuations(input: {
  core: CoreInstance
  sessionId: string
  nodes: readonly SubagentNodeRecord[]
  specs: readonly DelegateAgentChildSpec[]
}): Promise<QueuedChildContinuationBatch> {
  const queuedBatch = queueChildContinuations(input)
  requireSaved(await input.core.persistence.persistRecovery(input.sessionId, 'subagent.children_queued'), 'children queued')
  return queuedBatch
}

/** Claims a just-created child once, records unknown outcome, then permits its first model work. */
export async function persistChildExecutionFence(input: {
  core: CoreInstance
  sessionId: string
  childId: string
  queuedBatch: QueuedChildContinuationBatch
}): Promise<void> {
  if (!fenceChildContinuation(input)) {
    throw new Error(`child continuation is not executable: ${input.childId}`)
  }
  requireSaved(await input.core.persistence.persistRecovery(input.sessionId, 'subagent.child_outcome_unknown'), 'child execution fence')
}

/** Marks terminal child results before confirming that their parent may receive the result. */
export async function persistTerminalChildResults(input: {
  core: CoreInstance
  sessionId: string
  children: readonly TerminalChildContinuation[]
}): Promise<void> {
  input.children.forEach((child) => {
    markChildContinuationTerminal({
      core: input.core,
      sessionId: input.sessionId,
      childId: child.childId,
      kind: child.kind,
      summary: child.summary,
      resultArchivePath: child.resultArchivePath,
      skillFiles: child.skillFiles,
      skillIds: child.skillIds,
      changeSets: child.changeSets,
    })
  })
  requireSaved(await input.core.persistence.persistRecovery(input.sessionId, 'subagent.child_terminal'), 'child terminal')
}

/** Records every child that ended before its own result finalizer could run. */
export async function persistTerminalChildBatch(input: {
  core: CoreInstance
  sessionId: string
  runId: string
  children: readonly ChildAgentResult[]
}): Promise<void> {
  await persistTerminalChildResults({
    core: input.core,
    sessionId: input.sessionId,
    children: input.children.map((child) => ({
      childId: `${input.runId}:${child.path}`,
      kind: child.status,
      summary: child.summary,
      resultArchivePath: child.resultFile,
      skillFiles: child.skillFiles,
      skillIds: child.skillIds,
      changeSets: child.changeSets ?? [],
    })),
  })
}

function requireSaved(outcome: RecoveryWriteOutcome | undefined, boundary: string): void {
  if (outcome === undefined || outcome.status === 'saved') return
  throw new Error(`recovery persistence did not save ${boundary}: ${outcome.status}`)
}
