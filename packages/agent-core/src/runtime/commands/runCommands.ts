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
import { runToolLoop } from '../modelRun'
import { newId } from '../newId'
import { canRememberToolApproval } from '../sessionApprovalMemory'
import { toolProviderDisconnectedResult } from '../toolLoading'
import { checkPendingToolRegistration } from './pendingToolRegistration'
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

    // 判据统一走本 run 的工具集 epoch（拿不到时回退活 registry），见 pendingToolRegistration.ts。
    const registration = checkPendingToolRegistration(core, id, run.runId, pending)
    const registrationStillCurrent = registration.state === 'current'
    // 「这一次能不能记」= 运行时条件（本轮判定）+ 工具名有没有记忆资格（单点判据，见
    // runtime/sessionApprovalMemory.ts；不要在这里重写名字匹配）。
    const rememberApproval = approved
      && Boolean(always)
      && registrationStillCurrent
      && pending.risk !== 'critical'
      && !pending.irreversible
      && canRememberToolApproval(pending.toolName)
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
        registrationState: registration.state,
        registrationSource: registration.source,
        currentRegistrationVersion: registration.currentRegistrationVersion,
        ...(registration.epochId ? { epochId: registration.epochId, epochStatus: registration.epochStatus } : {}),
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

    // 「所属服务已断开」与「实例被换掉」在这里分道：后者恢复执行时会被 registry.run 的
    // expectedRegistrationVersion 挡下，回一句 `tool registration version mismatch`，模型
    // 重读 schema 即可自愈；前者本轮无救——恢复执行只会换来一句给运维看的 `unknown tool: X`，
    // 模型会以为自己名字写错而原样重试。所以就地回 E2 那份结构化回执，不再进执行路径。
    if (registration.state === 'disconnected') {
      addEvent('agent.confirmation.provider_disconnected', {
        span: getActiveSpan(runTraceKey(id, run.runId)),
        attrs: {
          sessionId: id,
          runId: run.runId,
          toolName: pending.toolName,
          callId: pending.callId,
          tool_provider_disconnected: true,
          epochId: registration.epochId,
        },
      })
      appendItem(id, {
        id: newId(),
        createdAt: Date.now(),
        item: {
          role: 'tool',
          tool_call_id: pending.callId,
          content: JSON.stringify(toolProviderDisconnectedResult(pending.toolName)),
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
