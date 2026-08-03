import { type ModelFunctionTool } from '@web-agent/ai'
import { sessionsAtom, workspacesAtom } from '../state/rootStore'
import { isToolAlwaysAllowed } from '../state/transientAtoms'
import type { PendingToolConfirmation } from '../state/core.type'
import { resolveSessionWorkspaceRoot } from '../state/workspaceState'
import { patchRun } from '../state/sessionWriters'
import { classifyToolRisk } from './dangerousTools'
import { parseToolCallArgs } from './modelTurn'
import { appendMappedToolResult, appendToolResult, argsPreviewForModel, toolCallValidationError } from './toolLoopSupport'
import { tracePreview } from './shared/preview'
import { startSpan, endSpan } from '../observability/trace'
import { executeToolCall, type ExecutableToolCall } from './toolCallExecutor'
import { handleToolGate } from './toolCallGate'
import type { ToolLoopBase } from './toolLoopContracts'
import type { ModelTurnResult } from './modelTurnRequester'
import { pendingDecisionOrigin, planApprovalPayload } from './toolLoopPlan'
import { questionCount } from './toolLoopSupport'

export type ToolBatchResult = 'continue' | 'paused' | 'stale' | 'stopped' | 'aborted'

export interface ToolBatchInput {
  result: ModelTurnResult
  planStageId?: string
  finishReason: string | null | undefined
  persistWorkingTurn(): void
  recordToolOutcome(name: string, result: Awaited<ReturnType<typeof executeToolCall>>): void
}

/** Completes one assistant tool-call batch while preserving protocol result ordering. */
export async function runToolCallBatch(base: ToolLoopBase, input: ToolBatchInput): Promise<ToolBatchResult> {
  const { toolCalls, tools, exposedRegistrationVersions } = input.result
  let pauseCall: { callId: string; payload: unknown } | undefined
  let confirmCall: PendingToolConfirmation | undefined
  const interruptPending = () => pauseCall !== undefined || confirmCall !== undefined
  const statusAfterAwait = (): ToolBatchResult | undefined => !base.control.isCurrent() ? 'stale' : !base.control.isRunning() ? 'stopped' : base.opts.signal.aborted ? 'aborted' : undefined
  const isParallel = (toolCall: typeof toolCalls[number]): ExecutableToolCall | undefined => {
    const parsed = parseToolCallArgs(toolCall.function.arguments)
    if (!parsed.ok || toolCallValidationError(toolCall.function.name, parsed.args)) return undefined
    const registrationVersion = exposedRegistrationVersions.get(toolCall.function.name)
    if (registrationVersion === undefined || base.core.tools.registrationVersion(toolCall.function.name) !== registrationVersion || base.core.tools.execution(toolCall.function.name)?.mode !== 'parallel') return undefined
    const session = base.core.rootStore.getter(sessionsAtom)[base.id]
    const workspaceRoot = resolveSessionWorkspaceRoot(session, base.core.rootStore.getter(workspacesAtom))
    const risk = classifyToolRisk(toolCall.function.name, parsed.args, { workspaceRoot })
    return risk.requiresConfirmation || risk.level === 'critical' || risk.level === 'dangerous' ? undefined : { callId: toolCall.id, name: toolCall.function.name, args: parsed.args, registrationVersion }
  }
  const parallelCalls = toolCalls.map(isParallel).filter((call): call is ExecutableToolCall => call !== undefined)
  if (parallelCalls.length === toolCalls.length && parallelCalls.length > 1) {
    const results = await Promise.all(parallelCalls.map((call) => executeToolCall(base, call)))
    const state = statusAfterAwait()
    if (state) return state
    results.forEach((result, index) => { input.recordToolOutcome(parallelCalls[index].name, result); appendMappedToolResult(base.id, parallelCalls[index].callId, result, base.core, input.planStageId) })
    input.persistWorkingTurn()
    return 'continue'
  }
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name
    const parsed = parseToolCallArgs(toolCall.function.arguments)
    if (!parsed.ok) {
      const result = { error: parsed.error, hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象', argumentsPreview: argsPreviewForModel(parsed.raw) }
      const attrs = { toolName: name, callId: toolCall.id, args_parse_failed: true, finish_reason: input.finishReason, argsPreview: tracePreview(parsed.raw), resultPreview: tracePreview(result), errorPreview: parsed.error, error: parsed.error }
      base.trace.event('tool.args_invalid', attrs)
      const span = startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...attrs } })
      endSpan(span, 'error', attrs, parsed.error)
      appendToolResult(base.id, toolCall.id, JSON.stringify(result), base.core, input.planStageId)
      continue
    }
    const args = parsed.args
    const expectedRegistrationVersion = exposedRegistrationVersions.get(name)
    if (handleToolGate(base, { callId: toolCall.id, name, args, tools, expectedRegistrationVersion, planStageId: input.planStageId })) continue
    const validationError = toolCallValidationError(name, args)
    if (validationError) {
      const result = { error: validationError }
      const attrs = { toolName: name, callId: toolCall.id, validation_failed: true, argsPreview: tracePreview(args), resultPreview: tracePreview(result), errorPreview: validationError, validationError, error: validationError }
      base.trace.event('tool.validation_failed', attrs)
      const span = startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...attrs } })
      endSpan(span, 'error', attrs, validationError)
      if (name === 'submit_stage_result') base.state.lastStageSubmitRejection = validationError
      appendToolResult(base.id, toolCall.id, JSON.stringify(result), base.core, input.planStageId)
      continue
    }
    const registrationVersion = expectedRegistrationVersion!
    const session = base.core.rootStore.getter(sessionsAtom)[base.id]
    const workspaceRoot = resolveSessionWorkspaceRoot(session, base.core.rootStore.getter(workspacesAtom))
    const risk = classifyToolRisk(name, args, { workspaceRoot })
    const approvalMode = session?.toolApprovalMode ?? 'confirm'
    const needsConfirmation = risk.requiresConfirmation || risk.level === 'critical' || (approvalMode === 'confirm' && risk.level === 'dangerous' && !isToolAlwaysAllowed(base.id, name, base.core))
    if (needsConfirmation) {
      if (interruptPending()) appendToolResult(base.id, toolCall.id, JSON.stringify({ error: '已有待确认的工具调用，请先处理' }), base.core, input.planStageId)
      else confirmCall = risk.level === 'critical' || risk.requiresConfirmation ? { callId: toolCall.id, toolName: name, args, registrationVersion, ...(risk.level === 'critical' ? { risk: 'critical' as const } : { risk: 'dangerous' as const }), reason: risk.reason, irreversible: risk.irreversible } : { callId: toolCall.id, toolName: name, args, registrationVersion }
      continue
    }
    const result = await executeToolCall(base, { callId: toolCall.id, name, args, registrationVersion })
    const state = statusAfterAwait()
    if (state) return state
    input.recordToolOutcome(name, result)
    if ('pause' in result) {
      if (interruptPending()) appendToolResult(base.id, toolCall.id, JSON.stringify({ error: 'already pausing' }), base.core, input.planStageId)
      else pauseCall = { callId: toolCall.id, payload: result.pause }
    } else {
      appendMappedToolResult(base.id, toolCall.id, result, base.core, input.planStageId)
      if (name === 'submit_stage_result') base.state.lastStageSubmitRejection = result.ok ? undefined : result.error
    }
  }
  if (confirmCall) {
    base.trace.event('agent.waiting_confirmation', { toolName: confirmCall.toolName, callId: confirmCall.callId, args: confirmCall.args })
    patchRun(base.id, { status: 'waiting_confirmation', pendingToolConfirmation: confirmCall }, base.core)
    input.persistWorkingTurn()
    return 'paused'
  }
  if (pauseCall) return await pauseForUser(base, pauseCall, input.planStageId, input.persistWorkingTurn)
  input.persistWorkingTurn()
  return 'continue'
}

async function pauseForUser(base: ToolLoopBase, pauseCall: { callId: string; payload: unknown }, planStageId: string | undefined, persist: () => void): Promise<ToolBatchResult> {
  const approval = planApprovalPayload(pauseCall.payload)
  if (approval) {
    base.trace.event('agent.waiting_plan_approval', { callId: pauseCall.callId, ...approval })
    patchRun(base.id, { status: 'waiting_plan_approval', pendingPlanApproval: { callId: pauseCall.callId, ...approval } }, base.core)
  } else {
    const origin = pendingDecisionOrigin(base.id, pauseCall.payload, planStageId, base.core)
    base.trace.event('agent.waiting_user', { callId: pauseCall.callId, question_count: questionCount(pauseCall.payload), decision_surface: origin.surface, decision_phase: origin.phase, plan_id: origin.planId, plan_stage_id: origin.stageId })
    patchRun(base.id, { status: 'waiting_user', pendingQuestion: pauseCall.payload, pendingUserDecision: { callId: pauseCall.callId, payload: pauseCall.payload, origin } }, base.core)
  }
  persist()
  return 'paused'
}
