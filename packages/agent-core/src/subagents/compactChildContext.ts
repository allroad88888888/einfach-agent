import type { ModelSettings } from '../state/core.type'
import { COMPACT_CONTEXT_TOOL_NAME } from '../tools/contextCompaction'
import type { ToolContext } from '../tools/types'
import { createContextCompactionCapability } from '../runtime/contextCompactionCapability'
import { contextNeedsDistillation } from '../runtime/contextDistillation'
import { dispatchTimedToolRegistrations } from '../runtime/timedDispatchLoop'
import { projectTimedToolResultOrphans } from '../runtime/timedToolResultProjection'
import { createChildContextCheckpoint, projectChildContextCheckpoint, type ChildContextProjection } from './childContextCheckpoint'
import type { CallModelObservation, ChildModelRequest } from './childModelClient'
import { childTimedToolTraceItem } from './childResult'
import { type DelegationCallState, type DelegateAgentRuntimeState, isAbortError, toErrorMessage } from './runtimeState'

/** Runs the registered compression tool against this child transcript, never the parent store. */
export async function compactChildContext(input: {
  runtime: DelegateAgentRuntimeState
  state: DelegationCallState
  args: ChildModelRequest
  projection: ChildContextProjection
  settings: ModelSettings
  inputBudgetTokens: number
  modelCallLimit: number
}): Promise<ChildContextProjection> {
  const { runtime, state, args, settings, inputBudgetTokens, modelCallLimit } = input
  const source = [...args.messages]
  let projection = input.projection
  const current = () => !runtime.disposed && !runtime.opts.signal.aborted
  const invocation = createContextCompactionCapability({
    stablePrefix: [], transcript: projection.messages, settings,
    apiKey: runtime.opts.apiKey, signal: runtime.opts.signal,
    fetchImpl: runtime.opts.fetchImpl, userId: runtime.opts.modelUserId,
    assertCurrent() {
      if (!current() || source.some((item, index) => args.messages[index] !== item)) {
        throw new Error('子 agent 待压缩上下文已变化，摘要未提交。')
      }
    },
    invoke: (request) => state.modelCallLimiter.run(() => {
      runtime.reserveModelCall(state, modelCallLimit)
      return request()
    }, runtime.opts.signal),
    commit(summary) {
      const checkpoint = createChildContextCheckpoint(source, summary)
      const next = projectChildContextCheckpoint(args.messages, checkpoint)
      if (next.invalidCheckpoint || contextNeedsDistillation(
        projectTimedToolResultOrphans(next.messages), args.tools ?? [], inputBudgetTokens,
      )) throw new Error('子 agent 上下文摘要仍超过请求预算；请缩小工具 schema 或子任务范围。')
      args.onContextCheckpoint?.(checkpoint)
      projection = next
      return { coveredItems: source.length, sourceEstimatedTokens: checkpoint.sourceEstimatedTokens, summaryChars: summary.length }
    },
  })
  const unavailable = (): never => { throw new Error('压缩工具只能使用当前子 agent 的摘要能力。') }
  const ctx: ToolContext = {
    sessionId: runtime.opts.sessionId, signal: runtime.opts.signal,
    progress: (text) => args.observe?.context.progress(text),
    contextCompaction: invocation.capability,
    callTool: unavailable, runShell: unavailable, renderCard: unavailable, saveArtifact: unavailable,
  }
  await recordEvent(runtime, args.observe, 'child_context_distillation_started', {
    sourceMessages: projection.messages.length, inputBudgetTk: inputBudgetTokens,
  })
  try {
    const name = COMPACT_CONTEXT_TOOL_NAME
    const registrationVersion = runtime.registry.registrationVersion(name)
    if (registrationVersion === undefined || runtime.registry.callTiming(name) !== 'compact') {
      throw new Error('子 agent 上下文压缩需要注册 compact_context 到点工具。')
    }
    let failure: string | undefined
    await dispatchTimedToolRegistrations({
      registrations: [{ name, registrationVersion, runtime: 'internal' }],
      isCurrent: current,
      createCallId: () => `timed:compact:${runtime.opts.runId}:${args.observe?.agentPath ?? 'unobserved'}:${args.observe?.turn ?? 0}:${name}`,
      execute: () => runtime.registry.run(name, {}, ctx, registrationVersion),
      isAbortError: (error) => isAbortError(error, runtime.opts.signal),
      record: async (_registration, callId, result) => {
        if (!('ok' in result) || !result.ok) failure = 'error' in result ? result.error : '压缩工具不能暂停。'
        if (args.observe) await runtime.archive.bestEffortRecordTraceItem(
          args.observe.context, args.observe.archiveBasePath, args.observe.agentPath,
          args.observe.turn, childTimedToolTraceItem(callId, result),
        )
      },
    })
    if (!current()) throw new DOMException('Aborted', 'AbortError')
    if (failure || !invocation.committed) throw new Error(failure ?? '子 agent 压缩工具未提交有效摘要。')
    await recordEvent(runtime, args.observe, 'child_context_distillation_succeeded', {
      sourceMessages: source.length, summaryChars: invocation.committed.summaryChars,
      sourceEstimatedTk: invocation.committed.sourceEstimatedTokens,
    })
    return projection
  } catch (error) {
    await recordEvent(runtime, args.observe, 'child_context_distillation_failed', { error: toErrorMessage(error) })
    throw error
  } finally {
    invocation.close()
  }
}

async function recordEvent(
  runtime: DelegateAgentRuntimeState,
  observe: CallModelObservation | undefined,
  type: 'child_context_distillation_started' | 'child_context_distillation_succeeded' | 'child_context_distillation_failed',
  data: Record<string, unknown>,
): Promise<void> {
  if (observe) await runtime.archive.bestEffortRecordEvent(
    observe.context, observe.archiveBasePath, type, observe.agentPath,
    { turn: observe.turn, phase: observe.phase, ...data },
  )
}
