import { removeToolActivity } from '../state/transientAtoms'
import { buildToolContext } from './toolContext'
import { getExecutionRuntime } from '../execution/runtime'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { startSpan, endSpan } from '../observability/trace'
import { abortStatus, safeErrorMessage, toolResultTrace } from './toolLoopSupport'
import type { ToolLoopBase } from './toolLoopContracts'

export interface ExecutableToolCall {
  callId: string
  name: string
  args: unknown
  registrationVersion?: number
  resumed?: boolean
}

/** Runs one already-gated tool call through the execution graph. */
export async function executeToolCall(base: ToolLoopBase, call: ExecutableToolCall) {
  const policy = base.core.tools.execution(call.name)
  const toolSpan = startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, toolName: call.name, callId: call.callId, args: call.args, ...(call.resumed ? { resumed: true, registrationVersion: call.registrationVersion } : {}) } })
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
    const traced = toolResultTrace(result, call.args)
    endSpan(toolSpan, traced.status, traced.attrs, traced.err)
    return result
  } catch (error) {
    endSpan(toolSpan, abortStatus(base.opts.signal, error), { error: safeErrorMessage(error) }, error)
    throw error
  } finally {
    removeToolActivity(base.id, call.callId, base.core)
  }
}
