import { maxTurnToolsForVendor } from '@web-agent/ai'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { activeSessionIdAtom, sessionsAtom } from '../state/rootStore'
import { appendItem, patchRun } from '../state/sessionWriters'
import { takeQueuedUserMessages } from '../state/transientAtoms'
import { buildStableModelPrefix } from './modelTurnPrefix'
import { injectStablePrefixTranscript } from './transcriptInjection'
import { loadedToolNamesFromHistory } from './modelTurn'
import { ensureToolLoaded } from './toolLoading'
import { defaultCore } from './core/coreInstance'
import { makeCoreCtx } from './core/coreCtx'
import { currentTurnItems, latestUserInput } from './runCheckpoints'
import { createToolLoopCheckpointWriter, type ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import { createRunGuard, isRunningRun } from './toolLoopSupport'
import { isCurrentRun } from './shared/runGuards'
import { newId } from './newId'
import { formatSubagentTranscript } from '../subagents/distill'
import { createDelegateAgentRuntime } from '../subagents/runtime'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { runtimeModelIdentity, delegateModelIdentity } from './core/delegateModelIdentity'
import { planResumeNotice } from './toolLoopPlan'
import { getExecutionRuntime } from '../execution/runtime'
import { addEvent, bindActiveSpan, clearActiveSpan, endSpan, getActiveSpan, runTraceKey, startSpan } from '../observability/trace'
import type { TraceAttributes } from '../observability/types'
import type { ToolLoopBase, ToolLoopControl, ToolLoopTrace } from './toolLoopContracts'
import type { ToolLoopOptions } from './modelRunLifecycle'

export interface BootstrappedToolLoop {
  base: ToolLoopBase
  checkpoints: ToolLoopCheckpointWriter
}

/** Creates the per-run dependencies before the state machine performs any model turn. */
export async function bootstrapToolLoop(id: string, runId: string, opts: ToolLoopOptions): Promise<BootstrappedToolLoop | undefined> {
  const core = opts.core ?? defaultCore
  const traceKey = runTraceKey(id, runId)
  const initialSession = core.rootStore.getter(sessionsAtom)[id]
  if (!initialSession) {
    const span = opts.traceSpan ?? getActiveSpan(traceKey)
    if (span) { addEvent('agent.session_missing', { span, attrs: { sessionId: id, runId } }); endSpan(span, 'cancelled', { reason: 'session_missing' }); clearActiveSpan(traceKey, span) }
    return undefined
  }
  const guard = createRunGuard(id, runId, core)
  const pluginRun = await core.plugins.activateRun(core.getSessionStore(id).store, {
    runId,
    isActiveSession: () => core.rootStore.getter(activeSessionIdAtom) === id,
  })
  let handedOff = false
  try {
    const hooks = pluginRun.hooks
    await hooks.onRunStart?.(makeCoreCtx({ sessionId: id, runId, signal: opts.signal, store: core.getSessionStore(id).store, root: core.rootStore, traceEvent: () => {} }))
    const session = core.rootStore.getter(sessionsAtom)[id]
    const turnId = opts.turnId ?? core.getSessionStore(id).store.getter(runAtom)?.turnId ?? currentTurnItems(id, core)[0]?.id ?? newId()
    if (core.getSessionStore(id).store.getter(runAtom) && !core.getSessionStore(id).store.getter(runAtom)?.turnId) patchRun(id, { turnId }, core)
    const span = opts.traceSpan ?? getActiveSpan(traceKey) ?? startSpan('agent.turn', { kind: 'agent', attrs: { sessionId: id, runId, turnId, vendor: session.settings.vendor, model: session.settings.model, resumed: true } })
    bindActiveSpan(traceKey, span)
    const baseAttrs: TraceAttributes = { sessionId: id, runId, turnId }
    const trace: ToolLoopTrace = {
      span,
      event: (name, attrs) => addEvent(name, { span, attrs: { ...baseAttrs, ...(attrs ?? {}) } }),
      finish: (status, eventName, attrs, error) => { addEvent(eventName, { span, attrs: { ...baseAttrs, ...(attrs ?? {}) } }); endSpan(span, status, attrs, error); clearActiveSpan(traceKey, span) },
    }
    const input = latestUserInput(id, core)
    const checkpoints = createToolLoopCheckpointWriter({ id, runId, labelInput: input, core, guard, traceEvent: trace.event, isRunning: () => isRunningRun(id, runId, core), resumeExisting: opts.resumePlan || opts.resumeInterrupted })
    const control: ToolLoopControl = {
      isCurrent: () => isCurrentRun(guard),
      isRunning: () => isRunningRun(id, runId, core),
    }
    checkpoints.persistWorkingTurn()
    const stablePrefix = await buildStableModelPrefix(session, core)
    if (!control.isCurrent()) { trace.finish('cancelled', 'agent.stale_run', { reason: 'stale_run' }); return undefined }
    if (!control.isRunning()) { checkpoints.commitStoppedTurn(); trace.finish('cancelled', 'agent.stopped', { reason: 'run_not_running' }); return undefined }
    if (opts.signal.aborted) { patchRun(id, { status: 'stopped' }, core); checkpoints.commitStoppedTurn(); trace.finish('cancelled', 'agent.stopped', { reason: 'aborted' }); return undefined }
    injectStablePrefixTranscript(id, stablePrefix, core)
    trace.event('llm.system_injected', { system_chars: stablePrefix.system.content.length, environment_chars: stablePrefix.environment.content.length, workspace_bound: stablePrefix.workspaceRoot !== undefined })
    if (session !== initialSession) trace.event('agent.model_migrated_at_request', { from: initialSession.settings.model, to: session.settings.model })
    const modelUserId = runtimeModelIdentity(core.config)
    const rootTranscript = () => formatSubagentTranscript([...stablePrefix.items, ...currentTurnItems(id, core).map((item) => item.item)])
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: id, runId, settings: session.settings, core, registry: core.tools, scheduler: core.subagentScheduler, customInstructions: core.config.customInstructions, environment: stablePrefix.environment.content, ...delegateModelIdentity(modelUserId), apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl,
      onNodeChange: (node) => getExecutionRuntime(core).syncAgentNode(node),
      onTraceItem: ({ agentPath, timestamp, turn, item }) => getExecutionRuntime(core).appendAgentTrace({ sessionId: id, treeId: runId, agentPath, record: { timestamp, turn, item } }),
    })
    const restored = new Set<string>()
    const stored = core.getSessionStore(id).store
    for (const name of [...(session.loadedTools ?? []), ...loadedToolNamesFromHistory(stored.getter(itemsAtom).map((item) => item.item)), ...(stored.getter(runAtom)?.loadedTools ?? [])]) if (name) { restored.delete(name); restored.add(name) }
    let visible = [] as ToolLoopBase['state']['visible']
    for (const name of restored) visible = ensureToolLoaded(id, visible, name, core, maxTurnToolsForVendor(session.settings.vendor) - 1)
    const pluginContext = makeCoreCtx({ sessionId: id, runId, signal: opts.signal, store: stored, root: core.rootStore, traceEvent: trace.event })
    const boot = {
      base: {
        id, runId, opts, core, turnId,
        maxTurnTools: maxTurnToolsForVendor(session.settings.vendor),
        settings: session.settings,
        modelUserId,
        runtimeIsTauri: stablePrefix.isTauri,
        stablePrefix,
        trace,
        control,
        state: {
          visible,
          recentToolNames: visible.map((tool) => tool.name).reverse(),
          ...(opts.resumePlan ? { planContinuation: planResumeNotice() } : {}),
          consecutivePlanTextTurns: 0,
          stageTurnsOnGuard: 0,
        },
        pluginContext,
        pluginRun,
        hooks,
        delegateRuntime,
        rootTranscript,
        promoteQueuedInputs: () => {
          const queued = takeQueuedUserMessages(id, runId, core)
          queued.forEach((message) => appendItem(id, { id: message.id, createdAt: message.createdAt, item: { role: 'user', content: message.content } }, core))
          if (queued.length) trace.event('agent.queued_user_messages_promoted', { count: queued.length })
          return queued.length
        },
      },
      checkpoints,
    }
    handedOff = true
    return boot
  } finally {
    if (!handedOff) pluginRun.dispose()
  }
}
