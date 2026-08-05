import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import { getPlan } from '../../state/planWriters'
import { patchRun } from '../../state/sessionWriters'
import { enqueueUserMessage } from '../../state/transientAtoms'
import { activeExecutionNodeIdsAtom, executionGraphAtom } from '../../execution/graph'
import { getExecutionRuntime } from '../../execution/runtime'
import { resumeInterruptedSession, resumePlanSession, runSession, persistCurrentRunRecovery } from '../modelRun'
import { newId } from '../newId'
import { closeUnresolvedToolCalls } from '../runCheckpoints'
import type { CoreInstance } from '../core/coreInstance'
import { assertRunStatus, resolveApiKey, withRun } from './runCommands'

interface RunLifecycleDependencies {
  renameSession(id: string, title: string): void
  defaultSessionTitle: string
  deriveSessionTitle(input: string): string
}

/** Builds commands that start, resume, or stop model runs for one runtime core. */
export function createRunLifecycleCommands(core: CoreInstance, dependencies: RunLifecycleDependencies) {
  function sendMessage(input: string): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    const content = input.trim()
    if (!id || !content) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (assertRunStatus(run, 'running', 'awaiting_tool')) {
      enqueueUserMessage(id, { id: newId(), createdAt: Date.now(), content, targetRunId: run.runId }, core)
      persistCurrentRunRecovery(id, core)
      return
    }
    if (assertRunStatus(run, 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'interrupted')) return
    closeUnresolvedToolCalls(id, core, '开始下一轮')
    if (meta.title === dependencies.defaultSessionTitle) {
      const title = dependencies.deriveSessionTitle(content)
      if (title) dependencies.renameSession(id, title)
    }
    const apiKey = resolveApiKey(meta, core)
    withRun(id, core, (signal) => runSession(id, content, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }))
  }

  function continueInterruptedRun(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (!assertRunStatus(run, 'interrupted')) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const apiKey = resolveApiKey(meta, core)
    withRun(id, core, (signal) => resumeInterruptedSession(id, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }))
  }

  function recoverOrphanedAwaitingToolRun(id: string): boolean {
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    if (!assertRunStatus(run, 'awaiting_tool') || run.pendingExecutionId) return false
    const graph = store.getter(executionGraphAtom)
    const active = store.getter(activeExecutionNodeIdsAtom)
      .some((executionId) => graph.nodes[executionId]?.runId === run.runId)
    if (active) return false
    patchRun(id, { status: 'interrupted', pendingExecutionId: undefined }, core)
    persistCurrentRunRecovery(id, core)
    return true
  }

  function continuePlan(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (assertRunStatus(run, 'awaiting_tool') && recoverOrphanedAwaitingToolRun(id)) return continueInterruptedRun()
    if (assertRunStatus(run, 'interrupted')) return continueInterruptedRun()
    if (assertRunStatus(run, 'running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval')) return
    const plan = getPlan(id, core)
    if (!plan || !['approved', 'active'].includes(plan.status)) return
    if (!plan.stages.some((stage) => ['pending', 'in_progress'].includes(stage.status))) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const apiKey = resolveApiKey(meta, core)
    withRun(id, core, (signal) => resumePlanSession(id, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }))
  }

  function stopRun(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    core.abort.abortRun(id)
    if (!assertRunStatus(run, 'running', 'awaiting_tool')) return
    closeUnresolvedToolCalls(id, core, '用户中断本轮')
    patchRun(id, { status: 'stopped', pendingExecutionId: undefined }, core)
    const executionIds = new Set(run.pendingExecutionId ? [run.pendingExecutionId] : [])
    const graph = store.getter(executionGraphAtom)
    for (const executionId of store.getter(activeExecutionNodeIdsAtom)) {
      const node = graph.nodes[executionId]
      if (node?.runId === run.runId && node.type === 'agent-batch' && !node.parentId) executionIds.add(executionId)
    }
    const executionRuntime = getExecutionRuntime(core)
    for (const executionId of executionIds) executionRuntime.cancel(id, executionId)
  }

  return { sendMessage, continueInterruptedRun, continuePlan, stopRun }
}
