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
import { executeToolCall, type ExecutableToolCall } from './toolCallExecutor'
import { handleToolGate } from './toolCallGate'
import { executePreparedToolCall, hasToolCallHooks, prepareToolCall } from './toolCallPluginHooks'
import { persistToolCallExecutionFence } from './toolCallExecutionFence'
import { requireRecoveryDurability } from './recoveryDurabilityBarrier'
import type { ToolLoopBase } from './toolLoopContracts'
import type { ModelTurnResult } from './modelTurnRequester'
import { pendingDecisionOrigin, planApprovalPayload } from './toolLoopPlan'
import { questionCount } from './toolLoopSupport'

export type ToolBatchResult = 'continue' | 'paused' | 'stale' | 'stopped' | 'aborted' | 'interrupted'

/**
 * 风险判定要用的运行时事实。两处 classifyToolRisk（并行准入预检与逐个分发）必须吃【同一份】
 * 上下文：少喂一个探针，同一次调用在两条路径上就会得出不同等级。
 *
 * MCP 的两根探针 core 自己都判不出来——「连接某个服务会不会在本机起子进程」「这次 mcp__*
 * 调用会不会先起一次进程」，事实都由宿主在装配 MCP manager / 占位工具时接进 config
 * （见 runtimeConfig 的 mcpConnectTarget 与 mcpToolLaunchTarget）。
 */
function riskContext(base: ToolLoopBase, workspaceRoot: string | undefined) {
  return {
    workspaceRoot,
    mcpConnectTarget: base.core.config.mcpConnectTarget,
    mcpToolLaunchTarget: base.core.config.mcpToolLaunchTarget,
  }
}

export interface ToolBatchInput {
  result: ModelTurnResult
  planStageId?: string
  finishReason: string | null | undefined
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
    const risk = classifyToolRisk(toolCall.function.name, parsed.args, riskContext(base, workspaceRoot))
    return risk.requiresConfirmation || risk.level === 'critical' || risk.level === 'dangerous' ? undefined : { callId: toolCall.id, name: toolCall.function.name, args: parsed.args, registrationVersion }
  }
  const parallelCalls = toolCalls.map(isParallel).filter((call): call is ExecutableToolCall => call !== undefined)
  if (!hasToolCallHooks(base) && parallelCalls.length === toolCalls.length && parallelCalls.length > 1) {
    if (!await persistToolCallExecutionFence(base, parallelCalls.map((call) => call.callId))) return 'interrupted'
    const state = statusAfterAwait()
    if (state) return state
    const results = await Promise.all(parallelCalls.map((call) => executeToolCall(base, call)))
    const stateAfterExecution = statusAfterAwait()
    if (stateAfterExecution) return stateAfterExecution
    results.forEach((result, index) => { input.recordToolOutcome(parallelCalls[index].name, result); appendMappedToolResult(base.id, parallelCalls[index].callId, result, base.core, input.planStageId) })
    return await requireRecoveryDurability(base.id, base.runId, base.core, 'tool_batch_completed')
      ? 'continue'
      : 'interrupted'
  }
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name
    const parsed = parseToolCallArgs(toolCall.function.arguments)
    if (!parsed.ok) {
      const result = { error: parsed.error, hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象', argumentsPreview: argsPreviewForModel(parsed.raw) }
      const attrs = { toolName: name, callId: toolCall.id, args_parse_failed: true, finish_reason: input.finishReason, argsPreview: tracePreview(parsed.raw), resultPreview: tracePreview(result), errorPreview: parsed.error, error: parsed.error }
      base.trace.event('tool.args_invalid', attrs)
      const span = base.core.observability.startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...attrs } })
      base.core.observability.endSpan(span, 'error', attrs, parsed.error)
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
      const span = base.core.observability.startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...attrs } })
      base.core.observability.endSpan(span, 'error', attrs, validationError)
      if (name === 'submit_stage_result') base.state.lastStageSubmitRejection = validationError
      appendToolResult(base.id, toolCall.id, JSON.stringify(result), base.core, input.planStageId)
      continue
    }
    const registrationVersion = expectedRegistrationVersion!
    const preparation = await prepareToolCall(base, {
      callId: toolCall.id,
      name,
      args,
      registrationVersion,
    })
    const preparationState = statusAfterAwait()
    if (preparationState) return preparationState
    if (preparation.kind === 'rejected') {
      input.recordToolOutcome(name, preparation.result)
      appendMappedToolResult(base.id, toolCall.id, preparation.result, base.core, input.planStageId)
      if (name === 'submit_stage_result' && !preparation.result.ok) {
        base.state.lastStageSubmitRejection = preparation.result.error
      }
      continue
    }
    const prepared = preparation.prepared
    const verifiedArgs = prepared.call.args as Record<string, unknown>
    const session = base.core.rootStore.getter(sessionsAtom)[base.id]
    const workspaceRoot = resolveSessionWorkspaceRoot(session, base.core.rootStore.getter(workspacesAtom))
    const risk = classifyToolRisk(name, verifiedArgs, riskContext(base, workspaceRoot))
    const approvalMode = session?.toolApprovalMode ?? 'confirm'
    const needsConfirmation = risk.requiresConfirmation || risk.level === 'critical' || (approvalMode === 'confirm' && risk.level === 'dangerous' && !isToolAlwaysAllowed(base.id, name, base.core))
    if (needsConfirmation) {
      if (interruptPending()) appendToolResult(base.id, toolCall.id, JSON.stringify({ error: '已有待确认的工具调用，请先处理' }), base.core, input.planStageId)
      else confirmCall = risk.level === 'critical' || risk.requiresConfirmation
        ? {
            callId: toolCall.id,
            toolName: name,
            args: verifiedArgs,
            registrationVersion,
            ...(prepared.schemaWarnings ? { schemaWarnings: prepared.schemaWarnings } : {}),
            ...(prepared.beforeToolHookCompleted ? { beforeToolHookCompleted: true } : {}),
            ...(risk.level === 'critical' ? { risk: 'critical' as const } : { risk: 'dangerous' as const }),
            reason: risk.reason,
            irreversible: risk.irreversible,
          }
        : {
            callId: toolCall.id,
            toolName: name,
            args: verifiedArgs,
            registrationVersion,
            ...(prepared.schemaWarnings ? { schemaWarnings: prepared.schemaWarnings } : {}),
            ...(prepared.beforeToolHookCompleted ? { beforeToolHookCompleted: true } : {}),
            // 普通 dangerous 也要带上 reason：有些工具的真实操作不在 args 里（例如
            // connect_mcp_server 只有 serverId，将要执行的命令来自宿主配置），
            // 丢掉 reason 用户就看不到自己在批准什么。
            ...(risk.reason ? { reason: risk.reason } : {}),
          }
      continue
    }
    if (!await persistToolCallExecutionFence(base, [toolCall.id])) return 'interrupted'
    const fenceState = statusAfterAwait()
    if (fenceState) return fenceState
    const result = await executePreparedToolCall(base, prepared)
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
    return await requireRecoveryDurability(base.id, base.runId, base.core, 'waiting_confirmation')
      ? 'paused'
      : 'interrupted'
  }
  if (pauseCall) return await pauseForUser(base, pauseCall, input.planStageId)
  return await requireRecoveryDurability(base.id, base.runId, base.core, 'tool_batch_completed')
    ? 'continue'
    : 'interrupted'
}

async function pauseForUser(base: ToolLoopBase, pauseCall: { callId: string; payload: unknown }, planStageId: string | undefined): Promise<ToolBatchResult> {
  const approval = planApprovalPayload(pauseCall.payload)
  if (approval) {
    base.trace.event('agent.waiting_plan_approval', { callId: pauseCall.callId, ...approval })
    patchRun(base.id, { status: 'waiting_plan_approval', pendingPlanApproval: { callId: pauseCall.callId, ...approval } }, base.core)
  } else {
    const origin = pendingDecisionOrigin(base.id, pauseCall.payload, planStageId, base.core)
    base.trace.event('agent.waiting_user', { callId: pauseCall.callId, question_count: questionCount(pauseCall.payload), decision_surface: origin.surface, decision_phase: origin.phase, plan_id: origin.planId, plan_stage_id: origin.stageId })
    patchRun(base.id, { status: 'waiting_user', pendingQuestion: pauseCall.payload, pendingUserDecision: { callId: pauseCall.callId, payload: pauseCall.payload, origin } }, base.core)
  }
  return await requireRecoveryDurability(base.id, base.runId, base.core, 'waiting_user')
    ? 'paused'
    : 'interrupted'
}
