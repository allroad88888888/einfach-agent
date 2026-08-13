import { removeToolActivity } from '../state/transientAtoms'
import { buildToolContext } from './toolContext'
import { getExecutionRuntime } from '../execution/runtime'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { abortStatus, safeErrorMessage, toolResultTrace } from './toolLoopSupport'
import { toolProviderDisconnectedResult } from './toolLoading'
import type { ToolResult } from '../tools/types'
import type { ToolLoopBase } from './toolLoopContracts'

export interface ExecutableToolCall {
  callId: string
  name: string
  args: unknown
  registrationVersion?: number
  resumed?: boolean
}

/**
 * 闸门放行之后、真正执行之前还有 await 窗口（插件 hook、危险工具确认恢复、并行批次），
 * MCP 正好在这段时间掉线是常态。此时 registry.run 会 fail-closed 回一句 `unknown tool: X`
 * ——那是给运维看的，不是给模型看的。
 *
 * 这里【不提前拦、不绕过 expectedRegistrationVersion】：先让 registry 照常执行并守卫，只在它
 * 失败、且本 run 的 epoch 判定该工具已 retired 时，把回执翻译成模型能据以改道的结构化结果，
 * 并把原始错误留在 details 里不丢信息。
 */
function disconnectedDuringCall(base: ToolLoopBase, name: string, result: ToolResult): ToolResult | undefined {
  if (!('ok' in result) || result.ok) return undefined
  if (base.toolEpoch.status(name) !== 'retired') return undefined
  return { ...toolProviderDisconnectedResult(name), ok: false, details: { underlyingError: result.error } }
}

/** Runs one already-gated tool call through the execution graph. */
export async function executeToolCall(base: ToolLoopBase, call: ExecutableToolCall) {
  const policy = base.core.tools.execution(call.name)
  const toolSpan = base.core.observability.startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, toolName: call.name, callId: call.callId, args: call.args, ...(call.resumed ? { resumed: true, registrationVersion: call.registrationVersion } : {}) } })
  try {
    const runTool = (signal: AbortSignal) => base.core.tools.run(call.name, call.args, buildToolContext({
      sessionId: base.id,
      runId: base.runId,
      signal,
      callId: call.callId,
      toolName: call.name,
      toolArgs: call.args,
      agentPath: ROOT_AGENT_PATH,
      getParentTranscript: base.rootTranscript,
      delegateRuntime: base.delegateRuntime,
      core: base.core,
    }), call.registrationVersion)
    const result = call.resumed ? await runTool(base.opts.signal) : await getExecutionRuntime(base.core).run({
      id: call.callId,
      graphId: base.runId,
      sessionId: base.id,
      runId: base.runId,
      type: 'tool',
      label: call.name,
      effectKeys: [...(policy?.effectKeys ?? [])],
      signal: base.opts.signal,
      task: runTool,
    })
    const disconnected = disconnectedDuringCall(base, call.name, result)
    const settled = disconnected ?? result
    const traced = toolResultTrace(settled, call.args)
    base.core.observability.endSpan(toolSpan, traced.status, disconnected ? { ...traced.attrs, tool_provider_disconnected: true } : traced.attrs, traced.err)
    return settled
  } catch (error) {
    base.core.observability.endSpan(toolSpan, abortStatus(base.opts.signal, error), { error: safeErrorMessage(error) }, error)
    throw error
  } finally {
    removeToolActivity(base.id, call.callId, base.core)
  }
}
