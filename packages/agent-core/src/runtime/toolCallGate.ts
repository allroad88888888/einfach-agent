import { toolSchemaLoadedResult } from '../tools/schemaResult'
import { toolSchemaNotLoadedResult, ensureToolLoaded } from './toolLoading'
import { searchToolManifestPage, touchRecentToolName } from './modelTurn'
import { selectToolGate } from './toolGates'
import { appendToolResult } from './toolLoopSupport'
import { tracePreview } from './shared/preview'
import { startSpan, endSpan } from '../observability/trace'
import { ROOT_AGENT_PATH } from '../subagents/path'
import type { ModelFunctionTool } from '@web-agent/ai'
import type { ToolLoopBase } from './toolLoopContracts'

export interface ToolGateInput {
  callId: string
  name: string
  args: Record<string, unknown>
  tools: ModelFunctionTool[]
  expectedRegistrationVersion: number | undefined
  planStageId?: string
}

/**
 * Handles non-executing gate decisions, including lazy schema loading.
 *
 * Every catalog read here goes through the run's tool epoch rather than the live
 * registry: schema discovery, autoload and the exposed registration version must
 * describe the same tool set the model was given at the start of this run.
 */
export function handleToolGate(base: ToolLoopBase, input: ToolGateInput): boolean {
  const gate = selectToolGate({
    name: input.name,
    args: input.args,
    turnTools: input.tools,
    isSynthesisTurn: false,
    isAllowedTool: (name) => {
      const schema = base.toolEpoch.loadSchema(name)
      return schema?.runtime !== 'server' || base.runtimeIsTauri
    },
    loadSchema: (name) => {
      const schema = base.toolEpoch.loadSchema(name)
      return schema && (schema.runtime !== 'server' || base.runtimeIsTauri) ? schema : undefined
    },
    expectedRegistrationVersion: input.expectedRegistrationVersion,
    registrationVersion: (name) => base.toolEpoch.registrationVersion(name),
    canExecuteTool: (name) => input.tools.some((tool) => tool.function.name === name),
    delegate: { name: '__root_delegate__', path: ROOT_AGENT_PATH, depth: 0, maxDepth: 1 },
  })
  const traceFailure = (event: string, attrs: Record<string, unknown>, result: Record<string, unknown>) => {
    const error = String(result.error)
    const traceAttrs = { toolName: input.name, callId: input.callId, ...attrs, argsPreview: tracePreview(input.args), resultPreview: tracePreview(result), errorPreview: error, error }
    base.trace.event(event, traceAttrs)
    const span = startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...traceAttrs } })
    endSpan(span, 'error', traceAttrs, error)
    if (input.name === 'submit_stage_result') base.state.lastStageSubmitRejection = error
    appendToolResult(base.id, input.callId, JSON.stringify(result), base.core, input.planStageId)
  }
  if (gate.kind === 'schema_autoloaded') {
    base.state.visible = ensureToolLoaded(base.id, base.state.visible, input.name, base.core, base.maxTurnTools - 1, base.state.planPinnedTools, base.toolEpoch)
    base.state.recentToolNames = touchRecentToolName(base.state.recentToolNames, input.name, base.maxTurnTools - 1)
    const result = gate.result as Record<string, unknown> & { hint?: string }
    base.trace.event('tool.schema_autoloaded', { toolName: input.name, callId: input.callId, schema_autoloaded: true, argsPreview: tracePreview(input.args), resultPreview: tracePreview(result) })
    const span = startSpan('request_tool_schema', { kind: 'internal', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, toolName: input.name, callId: input.callId, args: input.args } })
    endSpan(span, 'ok', { found: true, autoloaded: true, discovery: false, result })
    if (input.name === 'submit_stage_result') base.state.lastStageSubmitRejection = result.hint
    appendToolResult(base.id, input.callId, JSON.stringify(result), base.core, input.planStageId)
    return true
  }
  if (gate.kind === 'tool_not_allowed') {
    traceFailure('tool.schema_not_loaded', { schema_not_loaded: true }, toolSchemaNotLoadedResult(input.name))
    return true
  }
  if (gate.kind === 'schema_request_denied') {
    traceFailure('tool.schema_request_denied', { schema_request_denied: true, requestedToolName: gate.toolName }, gate.result)
    return true
  }
  if (gate.kind === 'registration_changed') {
    traceFailure('tool.registration_changed', { registration_changed: true, expectedRegistrationVersion: input.expectedRegistrationVersion, currentRegistrationVersion: base.toolEpoch.registrationVersion(input.name) }, gate.result)
    return true
  }
  if (gate.kind !== 'schema_request') return false
  const toolName = typeof input.args.toolName === 'string' ? input.args.toolName.trim() : ''
  const span = startSpan('request_tool_schema', { kind: 'internal', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, toolName, callId: input.callId, args: input.args } })
  let found: boolean
  let result: Record<string, unknown>
  if (toolName) {
    base.state.visible = ensureToolLoaded(base.id, base.state.visible, toolName, base.core, base.maxTurnTools - 1, base.state.planPinnedTools, base.toolEpoch)
    const schema = base.toolEpoch.loadSchema(toolName)
    found = schema !== undefined
    if (schema) base.state.recentToolNames = touchRecentToolName(base.state.recentToolNames, toolName, base.maxTurnTools - 1)
    result = schema ? toolSchemaLoadedResult(schema) : { error: 'unknown' }
  } else {
    const manifest = searchToolManifestPage({ query: typeof input.args.query === 'string' ? input.args.query : undefined, cursor: typeof input.args.cursor === 'string' ? input.args.cursor : undefined, limit: typeof input.args.limit === 'number' ? input.args.limit : undefined }, base.runtimeIsTauri, { registry: base.toolEpoch })
    found = manifest.kind === 'tool_manifest_page'
    result = manifest as unknown as Record<string, unknown>
  }
  base.trace.event('tool.schema_requested', { toolName: toolName || undefined, discovery: !toolName, callId: input.callId, found, args: input.args, result })
  endSpan(span, found ? 'ok' : 'error', { found, discovery: !toolName, result })
  appendToolResult(base.id, input.callId, JSON.stringify(result), base.core, input.planStageId)
  return true
}
