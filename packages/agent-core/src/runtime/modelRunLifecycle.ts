import { sessionsAtom } from '../state/rootStore'
import { planAtom, runAtom } from '../state/sessionAtoms'
import { appendItem, setRun } from '../state/sessionWriters'
import { currentTurnItems } from './activeTurnItems'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import { recoverInterruptedToolCalls } from './interruptedToolCallRecovery'
import { newId } from './newId'
import type { PendingToolConfirmation, RunState } from '../state/core.type'
import type { TraceSpan } from '../observability/port'
import type { UserMessageContent } from '@web-agent/ai'

export interface ModelRunOptions {
  signal: AbortSignal
  apiKey: string
  fetchImpl?: typeof fetch
  core?: CoreInstance
}

export interface ToolLoopOptions extends ModelRunOptions {
  resumeToolCall?: PendingToolConfirmation
  resumePlan?: boolean
  resumeInterrupted?: boolean
  traceSpan?: TraceSpan
  turnId?: string
}

export type ToolLoopRunner = (id: string, runId: string, opts: ToolLoopOptions) => Promise<void>

const EXECUTING_PLAN_STATUSES = new Set(['approved', 'active'])
const RECOVERY_PERSISTENCE_ERROR = 'Recovery persistence failed before model execution.'

function interruptedRunAsRunning(previousRun: RunState): RunState {
  const {
    pendingExecutionId: _pendingExecutionId,
    pendingToolCalls: _pendingToolCalls,
    pendingQuestion: _pendingQuestion,
    pendingUserDecision: _pendingUserDecision,
    pendingToolConfirmation: _pendingToolConfirmation,
    pendingPlanApproval: _pendingPlanApproval,
    error: _error,
    ...resumedRun
  } = previousRun
  return { ...resumedRun, status: 'running' }
}

function interruptedRunAfterPersistenceFailure(previousRun: RunState): RunState {
  const { pendingExecutionId: _pendingExecutionId, ...recoverableRun } = previousRun
  return { ...recoverableRun, status: 'interrupted', error: RECOVERY_PERSISTENCE_ERROR }
}

/** Admits a fresh model request only when its restart boundary is durably captured. */
async function persistBeforeModelLoop(id: string, core: CoreInstance, reason: string): Promise<boolean> {
  try {
    const outcome = await core.persistence.persistRecovery(id, reason)
    if (outcome === undefined || outcome.status === 'saved') return true
    blockModelLoopForPersistence(id, core, reason, outcome.status)
  } catch {
    blockModelLoopForPersistence(id, core, reason, 'error')
  }
  return false
}

function blockModelLoopForPersistence(id: string, core: CoreInstance, reason: string, outcome: string): void {
  const run = core.getSessionStore(id).store.getter(runAtom)
  if (run) setRun(id, interruptedRunAfterPersistenceFailure(run), core)
  core.observability.addEvent('agent.model_recovery_persistence_blocked', {
    attrs: { sessionId: id, reason, outcome },
  })
}

/** Starts a persisted user turn before passing control to the model loop. */
export async function startModelRun(id: string, input: UserMessageContent, opts: ModelRunOptions, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  const runId = newId()
  const userItemId = newId()
  const session = core.rootStore.getter(sessionsAtom)[id]
  const rootSpan = session ? core.observability.startSpan('agent.turn', { kind: 'agent', attrs: { sessionId: id, runId, turnId: userItemId, vendor: session.settings.vendor, model: session.settings.model } }) : undefined
  if (rootSpan) core.observability.bindActiveSpan(core.observability.runTraceKey(id, runId), rootSpan)
  const startedAt = Date.now()
  appendItem(id, { id: userItemId, createdAt: startedAt, item: { role: 'user', content: input } }, core)
  setRun(id, { runId, status: 'running', turnId: userItemId, startedAt }, core)
  if (!await persistBeforeModelLoop(id, core, 'model_run_started')) return
  await runLoop(id, runId, { ...opts, traceSpan: rootSpan, turnId: userItemId })
}

/** Restores an interrupted run only after persisted tool-call outcomes are reconciled. */
export async function continueInterruptedModelRun(id: string, opts: ModelRunOptions, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  const previousRun = core.getSessionStore(id).store.getter(runAtom)
  if (previousRun?.status !== 'interrupted') return
  if (await recoverInterruptedToolCalls(id, core) !== 'ready') return
  const reconciledRun = core.getSessionStore(id).store.getter(runAtom)
  if (reconciledRun?.status !== 'interrupted') return
  const plan = core.getSessionStore(id).store.getter(planAtom)
  setRun(id, interruptedRunAsRunning(reconciledRun), core)
  if (!await persistBeforeModelLoop(id, core, 'interrupted_run_resumed')) return
  await runLoop(id, reconciledRun.runId, { ...opts, resumeInterrupted: true, resumePlan: Boolean(plan && EXECUTING_PLAN_STATUSES.has(plan.status)), turnId: reconciledRun.turnId })
}

/** Starts the transient process needed to continue a persisted plan. */
export async function continuePlanModelRun(id: string, opts: ModelRunOptions & { runId?: string; turnId?: string }, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  if (await recoverInterruptedToolCalls(id, core) !== 'ready') return
  const reconciledRun = core.getSessionStore(id).store.getter(runAtom)
  const runId = opts.runId ?? newId()
  const resumedRun = opts.runId !== undefined && opts.runId === reconciledRun?.runId ? reconciledRun : undefined
  const turnId = opts.turnId ?? resumedRun?.turnId ?? currentTurnItems(id, core)[0]?.id
  setRun(id, {
    runId,
    status: 'running',
    ...(turnId === undefined ? {} : { turnId }),
    ...(resumedRun?.startedAt === undefined ? {} : { startedAt: resumedRun.startedAt }),
    ...(resumedRun?.loadedTools === undefined ? {} : { loadedTools: resumedRun.loadedTools }),
    ...(reconciledRun?.toolCallOutcomes === undefined ? {} : { toolCallOutcomes: reconciledRun.toolCallOutcomes }),
  }, core)
  if (!await persistBeforeModelLoop(id, core, 'plan_run_resumed')) return
  await runLoop(id, runId, { ...opts, resumePlan: true, turnId })
}
