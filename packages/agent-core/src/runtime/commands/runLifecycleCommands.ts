import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import { getPlan } from '../../state/planWriters'
import { patchRun } from '../../state/sessionWriters'
import { clearQueuedUserMessages, enqueueUserMessage } from '../../state/transientAtoms'
import { activeExecutionNodeIdsAtom, executionGraphAtom } from '../../execution/graph'
import { getExecutionRuntime } from '../../execution/runtime'
import { resumeInterruptedSession, resumePlanSession, runSession, persistCurrentRunRecovery } from '../modelRun'
import { newId } from '../newId'
import { closeUnresolvedToolCalls } from '../runCheckpoints'
import type { CoreInstance } from '../core/coreInstance'
import { cancelSessionSubmissions, scheduleSessionSubmission } from '../sessionSubmissionGate'
import { executePreparedUserInput } from '../preparedUserInputTransaction'
import {
  defaultPrepareUserInput,
  hasPreparedUserContent,
  hasUserInput,
  normalizeUserInput,
  type SendMessageInput,
  type SendMessageResult,
} from '../userInputPreparation'
import { assertRunStatus, resolveApiKey, withRun } from './runCommands'
import type { ModelSettings } from '../../state/core.type'
import type { UserMessageContent } from '@web-agent/ai'
import {
  captureUserContentReachability,
  disposeUserContentAfterMutation,
} from '../userContentDisposal'
import { persistStoppedRunCheckpoint } from '../runCheckpoints'
import { canonicalContextCacheValue } from '../contextCacheFingerprint'

interface RunLifecycleDependencies {
  renameSession(id: string, title: string): void
  defaultSessionTitle: string
  deriveSessionTitle(input: UserMessageContent): string
}

function rejected(reason: Extract<SendMessageResult, { accepted: false }>['reason'], error?: string): SendMessageResult {
  return { accepted: false, status: 'rejected', reason, ...(error ? { error } : {}) }
}

function settingsVersion(settings: ModelSettings): string {
  return canonicalContextCacheValue(settings)
}

/** Builds commands that start, resume, or stop model runs for one runtime core. */
export function createRunLifecycleCommands(core: CoreInstance, dependencies: RunLifecycleDependencies) {
  function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const id = core.rootStore.getter(activeSessionIdAtom)
    const submission = normalizeUserInput(input)
    if (!hasUserInput(submission)) return Promise.resolve(rejected('empty'))
    if (!id) return Promise.resolve(rejected('session_missing'))
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return Promise.resolve(rejected('session_missing'))
    const settings = { ...meta.settings } as ModelSettings
    const expectedSettingsVersion = settingsVersion(settings)
    const apiKey = resolveApiKey(meta, core)
    const fetchImpl = core.config.fetchImpl
    const prepare = core.config.prepareUserInput ?? defaultPrepareUserInput
    return scheduleSessionSubmission(core, id, (submissionSequence, prepareSignal) => {
      const commit = (content: UserMessageContent): SendMessageResult => {
        if (!hasPreparedUserContent(content)) {
          return rejected('prepare_failed', 'Prepared user input is empty.')
        }
        const currentMeta = core.rootStore.getter(sessionsAtom)[id]
        if (!currentMeta) return rejected('session_missing')
        if (settingsVersion(currentMeta.settings) !== expectedSettingsVersion) {
          return rejected('settings_changed')
        }
        const run = core.getSessionStore(id).store.getter(runAtom)
        if (assertRunStatus(run, 'running', 'awaiting_tool')) {
          enqueueUserMessage(id, {
            id: newId(),
            createdAt: Date.now(),
            content,
            targetRunId: run.runId,
            submissionSequence,
          }, core)
          persistCurrentRunRecovery(id, core)
          return { accepted: true, status: 'queued', sessionId: id, submissionSequence }
        }
        if (assertRunStatus(run, 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'interrupted')) {
          return rejected('run_blocked')
        }
        closeUnresolvedToolCalls(id, core, '开始下一轮')
        if (currentMeta.title === dependencies.defaultSessionTitle) {
          const title = dependencies.deriveSessionTitle(content)
          if (title) dependencies.renameSession(id, title)
        }
        withRun(id, core, (signal) => runSession(id, content, { signal, apiKey, fetchImpl, core }))
        return { accepted: true, status: 'started', sessionId: id, submissionSequence }
      }

      return executePreparedUserInput(
        () => prepare(submission, { sessionId: id, settings, apiKey, signal: prepareSignal, fetchImpl }),
        prepareSignal,
        commit,
      )
    }).promise
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
    cancelSessionSubmissions(core, id)
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    core.abort.abortRun(id)
    if (!assertRunStatus(
      run,
      'running',
      'awaiting_tool',
      'waiting_user',
      'waiting_confirmation',
      'waiting_plan_approval',
      'interrupted',
    )) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    const before = meta ? captureUserContentReachability(core, id) : undefined
    closeUnresolvedToolCalls(id, core, '用户中断本轮')
    // No queued input can have a live owner once this session's only run stops.
    clearQueuedUserMessages(id, core)
    patchRun(id, { status: 'stopped', pendingExecutionId: undefined }, core)
    persistStoppedRunCheckpoint(id, run.runId, core)
    const executionIds = new Set(run.pendingExecutionId ? [run.pendingExecutionId] : [])
    const graph = store.getter(executionGraphAtom)
    for (const executionId of store.getter(activeExecutionNodeIdsAtom)) {
      const node = graph.nodes[executionId]
      if (node?.runId === run.runId && node.type === 'agent-batch' && !node.parentId) executionIds.add(executionId)
    }
    const executionRuntime = getExecutionRuntime(core)
    for (const executionId of executionIds) executionRuntime.cancel(id, executionId)
    if (meta && before) {
      disposeUserContentAfterMutation(core, before, {
        sessionId: id,
        reason: 'run_stopped',
        settings: { ...meta.settings },
      })
    }
  }

  return { sendMessage, continueInterruptedRun, continuePlan, stopRun }
}
