import type { JsonValue } from '../state/recoverySnapshot.type'
import { ROOT_AGENT_PATH } from './path'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from './types'

type TerminalKind = 'done' | 'failed' | 'cancelled'

/** The JSON-only task input needed to reconcile, never silently replay, a child. */
export interface ChildTaskSnapshot {
  objective: string
  mode?: string
  expectedOutput?: string
  modelTier?: 'pro' | 'flash'
  taskCategory?: 'retrieval' | 'extraction' | 'analysis' | 'implementation' | 'verification' | 'final_acceptance'
  riskLevel?: 'low' | 'medium' | 'high'
  crossModule?: boolean
  requiresTemporalNormalization?: boolean
  finalAcceptance?: boolean
  priorFailureCount?: number
  maxDepth?: number
  maxChildren?: number
  maxTurns?: number
  toolProfile?: 'delegate_only' | 'workspace_read' | 'workspace_verify'
  confirmedTools?: string[]
}

export interface ChildContinuationDescriptor {
  version: 1
  parent: {
    path: string
    delegationCallId: string
  }
  task: ChildTaskSnapshot
  lifecycle: 'active' | 'terminal'
  resumePolicy: 'requires_reconciliation'
  knownToolOutcome: { kind: 'none' } | { kind: 'unknown'; reason: string }
  nestedChildIds: string[]
  terminal?: {
    kind: TerminalKind
    summary: string
    resultArchivePath: string | null
    deliverables: {
      skillFiles: string[]
      skillIds: string[]
      changeSets: Array<{ id: string; reversible: boolean }>
    }
  }
}

export type ChildContinuationRecoveryDisposition =
  | { kind: 'requires_reconciliation'; reason: string }
  | { kind: 'await_input' }
  | { kind: 'deliver_terminal' }

/** Builds the JSON-only scheduling descriptor stored in the recovery projection. */
export function createChildContinuationDescriptor(
  node: SubagentNodeRecord,
  task: DelegateAgentChildSpec,
): ChildContinuationDescriptor {
  return {
    version: 1,
    parent: {
      path: node.parentPath ?? ROOT_AGENT_PATH,
      delegationCallId: requiredDelegationCallId(node),
    },
    task: copyTask(task),
    lifecycle: 'active',
    resumePolicy: 'requires_reconciliation',
    knownToolOutcome: { kind: 'none' },
    nestedChildIds: [],
  }
}

/** Converts an active descriptor to a fail-closed execution fence before child work starts. */
export function fenceChildContinuationDescriptor(
  descriptor: ChildContinuationDescriptor,
): ChildContinuationDescriptor {
  return {
    ...descriptor,
    knownToolOutcome: { kind: 'unknown', reason: 'child_execution_started' },
  }
}

/** Retains a terminal child result until the parent tool result itself is durably appended. */
export function terminalChildContinuationDescriptor(input: {
  descriptor: ChildContinuationDescriptor
  kind: TerminalKind
  summary: string
  resultArchivePath: string | undefined
  skillFiles: string[]
  skillIds: string[]
  changeSets: Array<{ id: string; reversible: boolean }>
}): ChildContinuationDescriptor {
  return {
    ...input.descriptor,
    lifecycle: 'terminal',
    knownToolOutcome: { kind: 'unknown', reason: 'terminal_child_outcome_recorded' },
    terminal: {
      kind: input.kind,
      summary: input.summary,
      resultArchivePath: input.resultArchivePath ?? null,
      deliverables: {
        skillFiles: [...input.skillFiles],
        skillIds: [...input.skillIds],
        changeSets: input.changeSets.map((changeSet) => ({ ...changeSet })),
      },
    },
  }
}

export function appendNestedChildIds(
  descriptor: ChildContinuationDescriptor,
  childIds: readonly string[],
): ChildContinuationDescriptor {
  return {
    ...descriptor,
    nestedChildIds: Array.from(new Set([...descriptor.nestedChildIds, ...childIds])),
  }
}

/** Serializes the typed descriptor without relying on an unsafe structural cast. */
export function childContinuationDescriptorJson(descriptor: ChildContinuationDescriptor): JsonValue {
  return {
    version: 1,
    parent: { path: descriptor.parent.path, delegationCallId: descriptor.parent.delegationCallId },
    task: taskJson(descriptor.task),
    lifecycle: descriptor.lifecycle,
    resumePolicy: 'requires_reconciliation',
    knownToolOutcome: descriptor.knownToolOutcome.kind === 'none'
      ? { kind: 'none' }
      : { kind: 'unknown', reason: descriptor.knownToolOutcome.reason },
    nestedChildIds: [...descriptor.nestedChildIds],
    ...(descriptor.terminal ? {
      terminal: {
        kind: descriptor.terminal.kind,
        summary: descriptor.terminal.summary,
        resultArchivePath: descriptor.terminal.resultArchivePath,
        deliverables: {
          skillFiles: [...descriptor.terminal.deliverables.skillFiles],
          skillIds: [...descriptor.terminal.deliverables.skillIds],
          changeSets: descriptor.terminal.deliverables.changeSets.map((changeSet) => ({ ...changeSet })),
        },
      },
    } : {}),
  }
}

function copyTask(task: DelegateAgentChildSpec): ChildTaskSnapshot {
  return {
    objective: task.objective,
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    ...(task.expectedOutput === undefined ? {} : { expectedOutput: task.expectedOutput }),
    ...(task.modelTier === undefined ? {} : { modelTier: task.modelTier }),
    ...(task.taskCategory === undefined ? {} : { taskCategory: task.taskCategory }),
    ...(task.riskLevel === undefined ? {} : { riskLevel: task.riskLevel }),
    ...(task.crossModule === undefined ? {} : { crossModule: task.crossModule }),
    ...(task.requiresTemporalNormalization === undefined
      ? {} : { requiresTemporalNormalization: task.requiresTemporalNormalization }),
    ...(task.finalAcceptance === undefined ? {} : { finalAcceptance: task.finalAcceptance }),
    ...(task.priorFailureCount === undefined ? {} : { priorFailureCount: task.priorFailureCount }),
    ...(task.maxDepth === undefined ? {} : { maxDepth: task.maxDepth }),
    ...(task.maxChildren === undefined ? {} : { maxChildren: task.maxChildren }),
    ...(task.maxTurns === undefined ? {} : { maxTurns: task.maxTurns }),
    ...(task.toolProfile === undefined ? {} : { toolProfile: task.toolProfile }),
    ...(task.confirmedTools === undefined ? {} : { confirmedTools: [...task.confirmedTools] }),
  }
}

function taskJson(task: ChildTaskSnapshot): JsonValue {
  return {
    objective: task.objective,
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    ...(task.expectedOutput === undefined ? {} : { expectedOutput: task.expectedOutput }),
    ...(task.modelTier === undefined ? {} : { modelTier: task.modelTier }),
    ...(task.taskCategory === undefined ? {} : { taskCategory: task.taskCategory }),
    ...(task.riskLevel === undefined ? {} : { riskLevel: task.riskLevel }),
    ...(task.crossModule === undefined ? {} : { crossModule: task.crossModule }),
    ...(task.requiresTemporalNormalization === undefined ? {} : { requiresTemporalNormalization: task.requiresTemporalNormalization }),
    ...(task.finalAcceptance === undefined ? {} : { finalAcceptance: task.finalAcceptance }),
    ...(task.priorFailureCount === undefined ? {} : { priorFailureCount: task.priorFailureCount }),
    ...(task.maxDepth === undefined ? {} : { maxDepth: task.maxDepth }),
    ...(task.maxChildren === undefined ? {} : { maxChildren: task.maxChildren }),
    ...(task.maxTurns === undefined ? {} : { maxTurns: task.maxTurns }),
    ...(task.toolProfile === undefined ? {} : { toolProfile: task.toolProfile }),
    ...(task.confirmedTools === undefined ? {} : { confirmedTools: [...task.confirmedTools] }),
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function requiredDelegationCallId(node: SubagentNodeRecord): string {
  if (!isNonEmptyString(node.delegationCallId)) {
    throw new Error('child continuation requires a delegation call id')
  }
  return node.delegationCallId
}
