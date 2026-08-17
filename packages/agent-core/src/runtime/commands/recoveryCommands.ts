import { sessionsAtom } from '../../state/rootStore'
import { subagentContinuationsAtom } from '../../state/subagentContinuationAtoms'
import { itemsAtom, planAtom, runAtom } from '../../state/sessionAtoms'
import type { PlanStatus } from '../../planning/types'
import type { RunStatus } from '../../state/core.type'
import { resumeInterruptedSession, resumePlanSession } from '../modelRun'
import { unresolvedToolCalls } from '../toolCallOutcomeFacts'
import { isPureTool } from '../toolReversibility'
import type { CoreInstance } from '../core/coreInstance'
import { resolveApiKey, withRun } from './runCommands'

type AwaitingRunStatus = Extract<RunStatus, 'waiting_user' | 'waiting_confirmation' | 'waiting_plan_approval'>
type ResumablePlanStatus = Extract<PlanStatus, 'approved' | 'active'>

export type SessionRecoveryStatus =
  | {
    status: 'unavailable'
    sessionId: string
    reason: 'session_missing' | 'nonrecoverable'
  }
  | {
    status: 'awaiting_user'
    sessionId: string
    waitingFor: AwaitingRunStatus | 'plan_approval'
  }
  | {
    status: 'reconciliation_required'
    sessionId: string
    reason: 'subagent_continuation' | 'tool_outcome'
  }
  | {
    status: 'recoverable'
    sessionId: string
    continuation: 'interrupted_run'
    runId: string
  }
  | {
    status: 'recoverable'
    sessionId: string
    continuation: 'plan'
    planStatus: ResumablePlanStatus
  }

export type ContinueRecoveredSessionResult =
  | Exclude<SessionRecoveryStatus, { status: 'recoverable' }>
  | {
    status: 'continued'
    sessionId: string
    continuation: 'interrupted_run' | 'plan'
  }

/** Projects the durable recovery facts for a single session without selecting it. */
export function createRecoveryCommands(core: CoreInstance) {
  function getSessionRecoveryStatus(sessionId: string): SessionRecoveryStatus {
    const session = core.rootStore.getter(sessionsAtom)[sessionId]
    if (!session) return { status: 'unavailable', sessionId, reason: 'session_missing' }

    const store = core.findSessionStore(sessionId)?.store
    if (!store) return { status: 'unavailable', sessionId, reason: 'nonrecoverable' }
    if (store.getter(subagentContinuationsAtom).length > 0) {
      return { status: 'reconciliation_required', sessionId, reason: 'subagent_continuation' }
    }

    const run = store.getter(runAtom)
    if (run && isAwaitingUser(run.status)) {
      return { status: 'awaiting_user', sessionId, waitingFor: run.status }
    }
    if (run?.status === 'interrupted') {
      if (requiresToolReconciliation(sessionId, core)) {
        return { status: 'reconciliation_required', sessionId, reason: 'tool_outcome' }
      }
      return { status: 'recoverable', sessionId, continuation: 'interrupted_run', runId: run.runId }
    }
    if (run?.status === 'running' || run?.status === 'awaiting_tool') {
      return { status: 'unavailable', sessionId, reason: 'nonrecoverable' }
    }

    const plan = store.getter(planAtom)
    if (plan?.status === 'awaiting_approval') {
      return { status: 'awaiting_user', sessionId, waitingFor: 'plan_approval' }
    }
    if (plan && isResumablePlan(plan.status) && hasResumableStage(plan.stages)) {
      if (requiresToolReconciliation(sessionId, core)) {
        return { status: 'reconciliation_required', sessionId, reason: 'tool_outcome' }
      }
      return { status: 'recoverable', sessionId, continuation: 'plan', planStatus: plan.status }
    }
    return { status: 'unavailable', sessionId, reason: 'nonrecoverable' }
  }

  function listSessionRecoveryStatuses(): SessionRecoveryStatus[] {
    return Object.keys(core.rootStore.getter(sessionsAtom)).map(getSessionRecoveryStatus)
  }

  function continueRecoveredSession(sessionId: string): ContinueRecoveredSessionResult {
    const status = getSessionRecoveryStatus(sessionId)
    if (status.status !== 'recoverable') return status

    const session = core.rootStore.getter(sessionsAtom)[sessionId]
    if (!session) return { status: 'unavailable', sessionId, reason: 'session_missing' }
    const apiKey = resolveApiKey(session, core)
    if (status.continuation === 'interrupted_run') {
      withRun(sessionId, core, (signal) => resumeInterruptedSession(sessionId, {
        signal,
        apiKey,
        fetchImpl: core.config.fetchImpl,
        core,
      }))
    } else {
      withRun(sessionId, core, (signal) => resumePlanSession(sessionId, {
        signal,
        apiKey,
        fetchImpl: core.config.fetchImpl,
        core,
      }))
    }
    return { status: 'continued', sessionId, continuation: status.continuation }
  }

  return { getSessionRecoveryStatus, listSessionRecoveryStatuses, continueRecoveredSession }
}

function isAwaitingUser(status: RunStatus): status is AwaitingRunStatus {
  return status === 'waiting_user' || status === 'waiting_confirmation' || status === 'waiting_plan_approval'
}

/**
 * Admits only an unpaired normal call whose durable fact says it never started.
 * All other outcome facts must agree with the current run's transcript before
 * a lifecycle resume may bootstrap plugins or dispatch timed hooks.
 */
function requiresToolReconciliation(sessionId: string, core: CoreInstance): boolean {
  const store = core.findSessionStore(sessionId)?.store
  const run = store?.getter(runAtom)
  if (!store || !run) return false

  const items = store.getter(itemsAtom)
  const currentItems = items.slice(currentRunStart(items, run.turnId))
  // callId → 工具名：outcomeUnknown 的取舍要看该工具能否安全重发（见 toolReversibility）。
  const declared = new Map<string, string>()
  const receipts = new Set<string>()
  const timedReceipts = new Set<string>()
  for (const { item } of items) {
    if (item.role === 'tool' && item.tool_call_id.startsWith('timed:')) {
      timedReceipts.add(item.tool_call_id)
    }
  }
  for (const { item } of currentItems) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) declared.set(call.id, call.function.name)
    } else if (item.role === 'tool') {
      receipts.add(item.tool_call_id)
    }
  }

  for (const receipt of receipts) {
    if (!receipt.startsWith('timed:') && !declared.has(receipt)) return true
  }

  for (const [callId, outcome] of Object.entries(run.toolCallOutcomes ?? {})) {
    if (callId.startsWith('timed:')) {
      if (isTimedCallForRun(callId, run.runId) && (
        outcome.state !== 'outcomeKnown' || !timedReceipts.has(callId)
      )) return true
      continue
    }
    if (!declared.has(callId)) return true
    if (outcome.state === 'notStarted') {
      // 没跑过就不该有收据；有收据说明事实与 transcript 打架。
      if (receipts.has(callId)) return true
      continue
    }
    if (outcome.state === 'outcomeUnknown') {
      // 只读工具的未知结果由 recoverInterruptedToolCalls 写一条可重取收据后放行，
      // 所以此刻没有收据是正常的 —— 不能落到下面「结果已知必须有收据」那一条。
      if (!isPureTool(declared.get(callId) ?? '')) return true
      continue
    }
    // outcomeKnown：结果已知就必须有收据，只读也不豁免。
    if (!receipts.has(callId)) return true
  }

  return unresolvedToolCalls(sessionId, core).some((call) => (
    run.toolCallOutcomes?.[call.callId]?.state !== 'notStarted' && !isPureTool(call.name)
  ))
}

function currentRunStart(items: readonly { id: string; item: { role: string } }[], turnId: string | undefined): number {
  if (turnId) {
    const anchored = items.findIndex((entry) => entry.id === turnId)
    if (anchored >= 0) return anchored
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') return index
  }
  return 0
}

function isTimedCallForRun(callId: string, runId: string): boolean {
  if (callId.startsWith('timed:sessionStart:')) return true
  return callId.split(':')[2] === runId
}

function isResumablePlan(status: PlanStatus): status is ResumablePlanStatus {
  return status === 'approved' || status === 'active'
}

function hasResumableStage(stages: Array<{ status: string }>): boolean {
  return stages.some((stage) => stage.status === 'pending' || stage.status === 'in_progress')
}
