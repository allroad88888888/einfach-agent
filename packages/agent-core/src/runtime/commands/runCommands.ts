import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { appendItem, patchRun } from '../../state/sessionWriters'
import {
  addAlwaysAllowedTool,
  clearPendingQuestionAnswers,
  getPendingQuestionAnswers,
} from '../../state/transientAtoms'
import type {
  ConversationItem,
  PendingToolConfirmation,
  RunState,
  RunStatus,
  SessionMeta,
} from '../../state/core.type'
import { addEvent, getActiveSpan, runTraceKey } from '../../observability/trace'
import { isMcpTool } from '../dangerousTools'
import { runToolLoop } from '../modelRun'
import { newId } from '../newId'
import type { CoreInstance } from '../core/coreInstance'

export function resolveApiKey(meta: SessionMeta | undefined, core: CoreInstance): string {
  switch (meta?.settings.vendor) {
    case 'glm': return core.config.glmApiKey
    case 'kimi': return core.config.kimiApiKey
    default: return core.config.deepseekApiKey
  }
}

export function withRun(
  id: string,
  core: CoreInstance,
  start: (signal: AbortSignal) => Promise<unknown>,
): void {
  const signal = core.abort.beginRun(id)
  void start(signal).finally(() => core.abort.endRun(id, signal))
}

export function assertRunStatus(
  run: RunState | undefined,
  ...expectedStatuses: RunStatus[]
): run is RunState {
  return Boolean(run && expectedStatuses.includes(run.status))
}

function findAskUserToolCallId(items: ConversationItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index].item
    if (item.role === 'assistant') {
      return item.tool_calls?.find((toolCall) => toolCall.function.name === 'ask_user_question')?.id
    }
  }
  return undefined
}

export function resumePausedRun(
  id: string,
  run: RunState,
  patch: Omit<Partial<RunState>, 'status'>,
  core: CoreInstance,
  options: { apiKey?: string, resumeToolCall?: PendingToolConfirmation } = {},
): void {
  patchRun(id, { ...patch, status: 'running' }, core)
  const apiKey = options.apiKey ?? resolveApiKey(core.rootStore.getter(sessionsAtom)[id], core)
  withRun(id, core, (signal) => runToolLoop(id, run.runId, {
    signal,
    apiKey,
    fetchImpl: core.config.fetchImpl,
    ...(options.resumeToolCall ? { resumeToolCall: options.resumeToolCall } : {}),
    core,
  }))
}

/** Builds paused-run continuation commands bound to one runtime core. */
export function createRunCommands(core: CoreInstance) {
  function resumeWithAnswers(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (!assertRunStatus(run, 'waiting_user')) return

    const pendingDecision = run.pendingUserDecision
    const toolCallId = pendingDecision?.callId
      ?? findAskUserToolCallId(core.getSessionStore(id).store.getter(itemsAtom))
    if (!toolCallId) {
      patchRun(id, { status: 'running', pendingQuestion: undefined, pendingUserDecision: undefined }, core)
      return
    }

    const answers = getPendingQuestionAnswers(id, core)
    clearPendingQuestionAnswers(id, core)
    addEvent('agent.resume.answers', {
      span: getActiveSpan(runTraceKey(id, run.runId)),
      attrs: { sessionId: id, runId: run.runId, callId: toolCallId, answers_count: Object.keys(answers).length },
    })
    appendItem(id, {
      id: newId(),
      createdAt: Date.now(),
      planStageId: pendingDecision?.origin.stageId,
      item: { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify({ answers }) },
    }, core)
    resumePausedRun(id, run, {
      pendingQuestion: undefined,
      pendingUserDecision: undefined,
    }, core)
  }

  function confirmTool(approved: boolean, always?: boolean): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (!assertRunStatus(run, 'waiting_confirmation')) return

    const pending = run.pendingToolConfirmation
    if (!pending) {
      addEvent('agent.confirmation.missing_pending', {
        span: getActiveSpan(runTraceKey(id, run.runId)),
        attrs: { sessionId: id, runId: run.runId },
      })
      patchRun(id, { status: 'running', pendingToolConfirmation: undefined }, core)
      return
    }

    const registrationStillCurrent = pending.registrationVersion === undefined
      || core.tools.registrationVersion(pending.toolName) === pending.registrationVersion
    const rememberApproval = approved
      && Boolean(always)
      && registrationStillCurrent
      && pending.risk !== 'critical'
      && !pending.irreversible
      && !isMcpTool(pending.toolName)
    addEvent('agent.confirmation.decision', {
      span: getActiveSpan(runTraceKey(id, run.runId)),
      attrs: {
        sessionId: id,
        runId: run.runId,
        toolName: pending.toolName,
        callId: pending.callId,
        approved,
        always: rememberApproval,
        registrationVersion: pending.registrationVersion,
        registrationStillCurrent,
      },
    })
    const apiKey = resolveApiKey(core.rootStore.getter(sessionsAtom)[id], core)

    if (!approved) {
      appendItem(id, {
        id: newId(),
        createdAt: Date.now(),
        item: {
          role: 'tool',
          tool_call_id: pending.callId,
          content: JSON.stringify({ error: '用户拒绝执行该工具' }),
        },
      }, core)
      resumePausedRun(id, run, { pendingToolConfirmation: undefined }, core, { apiKey })
      return
    }

    if (rememberApproval) addAlwaysAllowedTool(id, pending.toolName, core)
    resumePausedRun(id, run, { pendingToolConfirmation: undefined }, core, {
      apiKey,
      resumeToolCall: pending,
    })
  }

  return { resumeWithAnswers, confirmTool }
}
