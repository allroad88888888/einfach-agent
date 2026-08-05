import { sessionsAtom } from '../state/rootStore'
import { planAtom, runAtom } from '../state/sessionAtoms'
import { appendItem, setRun } from '../state/sessionWriters'
import { closeUnresolvedToolCalls, currentTurnItems } from './runCheckpoints'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import { newId } from './newId'
import { bindActiveSpan, runTraceKey, startSpan } from '../observability/trace'
import type { PendingToolConfirmation } from '../state/core.type'
import type { TraceSpan } from '../observability/types'

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

/** Starts a persisted user turn before passing control to the model loop. */
export async function startModelRun(id: string, input: string, opts: ModelRunOptions, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  const runId = newId()
  const userItemId = newId()
  const session = core.rootStore.getter(sessionsAtom)[id]
  const rootSpan = session ? startSpan('agent.turn', { kind: 'agent', attrs: { sessionId: id, runId, turnId: userItemId, vendor: session.settings.vendor, model: session.settings.model } }) : undefined
  if (rootSpan) bindActiveSpan(runTraceKey(id, runId), rootSpan)
  const startedAt = Date.now()
  appendItem(id, { id: userItemId, createdAt: startedAt, item: { role: 'user', content: input } }, core)
  setRun(id, { runId, status: 'running', turnId: userItemId, startedAt }, core)
  await runLoop(id, runId, { ...opts, traceSpan: rootSpan, turnId: userItemId })
}

/** Restores an interrupted run after closing any persisted, side-effect-unknown tool calls. */
export async function continueInterruptedModelRun(id: string, opts: ModelRunOptions, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  const previousRun = core.getSessionStore(id).store.getter(runAtom)
  if (previousRun?.status !== 'interrupted') return
  closeUnresolvedToolCalls(id, core, '应用重启')
  const plan = core.getSessionStore(id).store.getter(planAtom)
  setRun(id, { ...previousRun, status: 'running', pendingExecutionId: undefined, pendingToolCalls: undefined, pendingQuestion: undefined, pendingUserDecision: undefined, pendingToolConfirmation: undefined, pendingPlanApproval: undefined, error: undefined }, core)
  await runLoop(id, previousRun.runId, { ...opts, resumeInterrupted: true, resumePlan: Boolean(plan && EXECUTING_PLAN_STATUSES.has(plan.status)), turnId: previousRun.turnId })
}

/** Starts the transient process needed to continue a persisted plan. */
export async function continuePlanModelRun(id: string, opts: ModelRunOptions & { runId?: string; turnId?: string }, runLoop: ToolLoopRunner): Promise<void> {
  const core = opts.core ?? defaultCore
  const previousRun = core.getSessionStore(id).store.getter(runAtom)
  const runId = opts.runId ?? newId()
  const resumedRun = opts.runId !== undefined && opts.runId === previousRun?.runId ? previousRun : undefined
  const turnId = opts.turnId ?? resumedRun?.turnId ?? currentTurnItems(id, core)[0]?.id
  setRun(id, { runId, status: 'running', turnId, startedAt: resumedRun?.startedAt, loadedTools: resumedRun?.loadedTools }, core)
  await runLoop(id, runId, { ...opts, resumePlan: true, turnId })
}
