import {
  toolProviderNotConnectedResult,
  toolSchemaLoadedResult,
  type UnconnectedToolProvider,
} from '../tools/schemaResult'
import { toolProviderDisconnectedResult, toolSchemaNotLoadedResult, ensureToolLoaded } from './toolLoading'
import { searchToolManifestPage, touchRecentToolName } from './modelTurn'
import { REQUEST_TOOL_SCHEMA_NAME, selectToolGate } from './toolGates'
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
 * 本次调用真正指向的、且在本 run 内已掉线的工具名；否则 undefined。
 *
 * 两个入口都要认：直接调用它，或用 request_tool_schema 点名它。后者拦下来省的不只是一轮
 * 对话——放它加载成功，模型下一轮才会撞墙，中间还白白改了一次 tool-set（provider 前缀缓存
 * 整段失效）。判据只有 epoch.status()，不看工具名长什么样。
 */
function retiredToolTarget(base: ToolLoopBase, input: ToolGateInput): string | undefined {
  if (base.toolEpoch.status(input.name) === 'retired') return input.name
  if (input.name !== REQUEST_TOOL_SCHEMA_NAME) return undefined
  const requested = typeof input.args.toolName === 'string' ? input.args.toolName.trim() : ''
  return requested && base.toolEpoch.status(requested) === 'retired' ? requested : undefined
}

/**
 * 本次调用真正指向的、出自某个未连接服务的工具名 + 它的提供方；否则 undefined。
 *
 * 判据是 epoch.status(name) === 'absent'（本 run 的清单里没有、registry 里也没有的真·未知名），
 * 不看工具名长什么样——「这个名字归谁」是宿主的事实，core 只在自己彻底不认识时问一次。
 * 与 retiredToolTarget 一样认两个入口：直接调用它，或用 request_tool_schema 点名它。
 */
function unconnectedProviderTarget(
  base: ToolLoopBase,
  input: ToolGateInput,
): { toolName: string; provider: UnconnectedToolProvider } | undefined {
  const probe = base.core.config.unconnectedToolProvider
  if (!probe) return undefined
  const candidate = input.name === REQUEST_TOOL_SCHEMA_NAME
    ? (typeof input.args.toolName === 'string' ? input.args.toolName.trim() : '')
    : input.name
  if (!candidate || base.toolEpoch.status(candidate) !== 'absent') return undefined
  try {
    const provider = probe(candidate)
    return provider ? { toolName: candidate, provider } : undefined
  } catch {
    // 探针是宿主代码。它崩了只回落到未知工具的原有路径，既不能让一次工具调用跟着崩，
    // 也不能反过来断言「有个未连接的服务」——查不到就当查不到。
    return undefined
  }
}

/**
 * Handles non-executing gate decisions, including lazy schema loading.
 *
 * Every catalog read here goes through the run's tool epoch rather than the live
 * registry: schema discovery, autoload and the exposed registration version must
 * describe the same tool set the model was given at the start of this run.
 */
export function handleToolGate(base: ToolLoopBase, input: ToolGateInput): boolean {
  const traceFailure = (event: string, attrs: Record<string, unknown>, result: Record<string, unknown>) => {
    const error = String(result.error)
    const traceAttrs = { toolName: input.name, callId: input.callId, ...attrs, argsPreview: tracePreview(input.args), resultPreview: tracePreview(result), errorPreview: error, error }
    base.trace.event(event, traceAttrs)
    const span = startSpan('tool.call', { kind: 'tool', parent: base.trace.span, attrs: { sessionId: base.id, runId: base.runId, turnId: base.turnId, ...traceAttrs } })
    endSpan(span, 'error', traceAttrs, error)
    if (input.name === 'submit_stage_result') base.state.lastStageSubmitRejection = error
    appendToolResult(base.id, input.callId, JSON.stringify(result), base.core, input.planStageId)
  }
  // 只增不减（E2）的「不减」侧，排在所有其它闸门【之前】：清单里还在、registry 里已经没有的
  // 工具，在这里就地回结构化错误。晚一步，autoload 就会先给它装一份注销前的 schema，把模型
  // 骗到下一轮才在 registry 那里撞上一句 `unknown tool: X`。
  const retired = retiredToolTarget(base, input)
  if (retired) {
    traceFailure('tool.provider_disconnected', { tool_provider_disconnected: true, retiredToolName: retired }, toolProviderDisconnectedResult(retired))
    return true
  }
  // 未连接服务的缓存工具（B4）。按需连接模式下模型看得到未连接服务【上次已知】的工具清单，
  // 于是它可能跳过 connect_mcp_server 直接点名。也排在 selectToolGate 之前，因为默认的两条
  // 回执都会把它带进死胡同：直接调用得到「schema 尚未加载，请 request_tool_schema」，
  // 而 request_tool_schema 对一个不存在的工具只会回一句 unknown ——真正缺的是一次连接。
  const unconnected = unconnectedProviderTarget(base, input)
  if (unconnected) {
    traceFailure(
      'tool.provider_not_connected',
      {
        tool_provider_not_connected: true,
        unconnectedToolName: unconnected.toolName,
        serverId: unconnected.provider.serverId,
      },
      toolProviderNotConnectedResult(unconnected.toolName, unconnected.provider),
    )
    return true
  }
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
