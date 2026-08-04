import { normalizeCacheUsage, streamModel, type ModelChatResponse, type ModelFunctionTool, type ModelItem, type ModelRetryObserver } from '@web-agent/ai'
import { itemsAtom } from '../state/sessionAtoms'
import { contextStatsAtom, setContextStats } from '../state/transientAtoms'
import { buildTurnTools, narrowToolCalls, toolSetSchemaFingerprint } from './modelTurn'
import { contextInputBudgetTokens, type CompactionRequestDraft } from './core/plugins/compactionPlugin'
import { createContextCacheTracker } from './contextCache'
import { injectToolTranscript } from './transcriptInjection'
import { buildContextStatsSnapshot, llmTracePreview, responseChars, toolNames, usageStats, usageTraceAttrs, accumulateCacheTotals } from './runLoopTelemetry'
import { refreshVisibleTools } from './toolLoading'
import { createAssistantStreamWriter } from './assistantStreamWriter'
import { abortStatus, safeErrorMessage } from './toolLoopSupport'
import type { ToolLoopBase } from './toolLoopContracts'
import { startSpan, endSpan } from '../observability/trace'
import { ROOT_AGENT_PATH } from '../subagents/path'

export interface ModelTurnResult {
  response: ModelChatResponse
  choice: NonNullable<ModelChatResponse['choices']>[number] | undefined
  message: NonNullable<ModelChatResponse['choices']>[number]['message'] | undefined
  toolCalls: ReturnType<typeof narrowToolCalls>
  tools: ModelFunctionTool[]
  exposedRegistrationVersions: Map<string, number>
  streamWriter: ReturnType<typeof createAssistantStreamWriter>
}

export type ModelTurnRequestOutcome = ModelTurnResult | {
  inactive: true
  streamWriter: ReturnType<typeof createAssistantStreamWriter>
}

export interface ModelTurnRequester {
  request(turn: number, planStageId: string | undefined, controls: ModelItem[]): Promise<ModelTurnRequestOutcome>
}

/** Builds current-request projections and sends one streaming model request. */
export function createModelTurnRequester(base: ToolLoopBase): ModelTurnRequester {
  const cacheTracker = createContextCacheTracker()
  const thinking = base.settings.thinking === undefined
    ? undefined
    : ({ type: base.settings.thinking ? 'enabled' : 'disabled' } as const)
  const callOptions = { apiKey: base.opts.apiKey, signal: base.opts.signal, fetchImpl: base.opts.fetchImpl }
  return {
    async request(turn, planStageId, controls) {
      const streamWriter = createAssistantStreamWriter(base.id, base.runId, base.opts.signal, base.core, planStageId)
      base.state.visible = refreshVisibleTools(base.id, base.state.visible, base.core, base.maxTurnTools - 1)
      const tools = buildTurnTools(base.state.visible, base.runtimeIsTauri, { registry: base.core.tools, vendor: base.settings.vendor, recentToolNames: base.state.recentToolNames })
      const names = toolNames(tools)
      const exposedRegistrationVersions = new Map<string, number>()
      for (const tool of base.state.visible) {
        if (!tools.some((candidate) => candidate.function.name === tool.name)) continue
        const version = tool.registrationVersion ?? base.core.tools.registrationVersion(tool.name)
        if (version !== undefined) exposedRegistrationVersions.set(tool.name, version)
      }
      const rawMessages: ModelItem[] = [...base.stablePrefix.items, ...base.core.getSessionStore(base.id).store.getter(itemsAtom).map((item) => item.item), ...controls]
      const draft: CompactionRequestDraft = { messages: rawMessages, tools, llmTurn: turn + 1, replayUnsafeToolNames: base.core.tools.replayUnsafeToolNames(), dynamicTailCount: controls.length }
      await base.hooks.transformContext?.(base.pluginContext, draft)
      if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) return { inactive: true, streamWriter }
      try {
        await base.hooks.prepareRequest?.(base.pluginContext, draft)
      } catch (error) {
        base.trace.event('agent.plugin_prepare_request_failed', { error: safeErrorMessage(error) })
        throw error
      }
      if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) return { inactive: true, streamWriter }
      const messages = draft.messages
      const compaction = draft.compaction!
      const cacheProfile = cacheTracker.observe({ lane: 'main', scope: `${base.id}:${base.runId}:${ROOT_AGENT_PATH}`, vendor: base.settings.vendor, model: base.settings.model, messages, systemContent: base.stablePrefix.content, tools, toolChoice: 'auto', thinking: thinking?.type, reasoningEffort: base.settings.reasoning_effort, compacted: compaction.compacted, dynamicControls: controls, requestMode: 'tool_loop' })
      const previousTotals = base.core.getSessionStore(base.id).store.getter(contextStatsAtom)?.cacheTotals
      const cacheTotals = previousTotals?.profileId === cacheProfile.profileId && previousTotals.epoch === cacheProfile.epoch ? previousTotals : undefined
      const contextStats = buildContextStatsSnapshot({ runId: base.runId, turnId: base.turnId, llmTurn: turn + 1, vendor: base.settings.vendor, model: base.settings.model, messages, tools, cacheProfile, cacheTotals, inputBudgetTokens: contextInputBudgetTokens(base.settings.vendor, base.settings.model, base.settings.max_tokens), estimatedTokensBeforeCompaction: compaction.compacted ? compaction.estimatedTokensBefore : undefined })
      setContextStats(base.id, contextStats, base.core)
      injectToolTranscript(base.id, tools, toolSetSchemaFingerprint(tools), base.core)
      base.trace.event('llm.tools_injected', { tools_count: tools.length, tool_names: names.join(',') })
      base.trace.event('llm.context_snapshot', { llm_turn: contextStats.llmTurn, messages_count: contextStats.messagesCount, tools_count: contextStats.toolsCount, dynamic_controls_count: controls.length, estimated_tokens: contextStats.estimatedTokens, total_chars: contextStats.totalChars, messages_chars: contextStats.messagesChars, tools_chars: contextStats.toolsChars, cache_profile: cacheProfile.profileId, cache_epoch: cacheProfile.epoch, cache_lane: cacheProfile.lane, cache_epoch_reason: cacheProfile.epochReason, cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint, cache_system_fingerprint: cacheProfile.systemFingerprint, cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint, tool_set_fingerprint: cacheProfile.toolSetFingerprint, cache_compaction_boundary: cacheProfile.compactionBoundary })
      const requestBase = { model: base.settings.model, messages, temperature: base.settings.temperature, max_tokens: base.settings.max_tokens, thinking, tools, tool_choice: 'auto' as const, stream: true }
      let retries = 0
      const llmSpan = startSpan('llm.chat', { kind: 'llm', parent: base.trace.span, attrs: () => ({ sessionId: base.id, runId: base.runId, turnId: base.turnId, llm_turn: contextStats.llmTurn, vendor: base.settings.vendor, model: base.settings.model, messages_count: messages.length, tools_count: tools.length, dynamic_controls_count: controls.length, adapter_retry_attempt: retries, estimated_context_tokens: contextStats.estimatedTokens, context_chars: contextStats.totalChars, tools_chars: contextStats.toolsChars, context_compacted: compaction.compacted, context_within_budget: compaction.withinBudget, cache_profile: cacheProfile.profileId, cache_epoch: cacheProfile.epoch, cache_lane: cacheProfile.lane, cache_epoch_reason: cacheProfile.epochReason, cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint, cache_system_fingerprint: cacheProfile.systemFingerprint, cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint, tool_set_fingerprint: cacheProfile.toolSetFingerprint, requestPreview: llmTracePreview({ ...requestBase, reasoning_effort: base.settings.reasoning_effort }) }) })
      const retryObserver: ModelRetryObserver = { canRetry: () => base.control.isCurrent() && base.control.isRunning() && !base.opts.signal.aborted, onRetry: (event) => { retries = event.attempt; base.trace.event('llm.model_retry', { status: event.status, retry_attempt: event.attempt, max_retries: event.maxRetries, response_id: event.response.id, response_model: event.response.model }) } }
      let response: ModelChatResponse
      try { response = await streamModel({ ...requestBase, settings: base.settings, userId: base.modelUserId }, callOptions, { onDelta: streamWriter.onDelta }, retryObserver) }
      catch (error) {
        streamWriter.finishPending()
        const status = abortStatus(base.opts.signal, error)
        endSpan(llmSpan, status, { error: safeErrorMessage(error), cache_metrics_status: status === 'cancelled' ? 'cancelled' : 'request_failed' }, error)
        if (retries > 0) base.trace.event('llm.model_retry_failed', { retry_attempt: retries, reason: status === 'cancelled' ? 'retry_request_cancelled' : 'retry_request_failed', error: safeErrorMessage(error) })
        if (base.control.isCurrent()) setContextStats(base.id, { ...contextStats, cache: { ...contextStats.cache!, metricsStatus: status === 'cancelled' ? 'cancelled' : 'request_failed' } }, base.core)
        throw error
      }
      const choice = response.choices?.[0]
      const message = choice?.message
      const toolCalls = narrowToolCalls(message?.tool_calls)
      endSpan(llmSpan, 'ok', () => ({ finish_reason: choice?.finish_reason ?? null, tool_calls_count: toolCalls.length, content_chars: responseChars(message?.content), reasoning_chars: responseChars(message?.reasoning_content), response_id: response.id, response_model: response.model, adapter_retry_attempt: retries, cache_metrics_status: normalizeCacheUsage(response.usage) ? 'available' : 'unavailable', responsePreview: llmTracePreview(response), ...usageTraceAttrs(response.usage) }))
      if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) return { inactive: true, streamWriter }
      const responseCacheUsage = normalizeCacheUsage(response.usage)
      setContextStats(base.id, { ...contextStats, usage: usageStats(response.usage), cache: { ...contextStats.cache!, metricsStatus: responseCacheUsage ? 'available' : 'unavailable' }, cacheTotals: accumulateCacheTotals(cacheTotals, response.usage, cacheProfile), finishReason: choice?.finish_reason ?? null, responseModel: response.model }, base.core)
      return { response, choice, message, toolCalls, tools, exposedRegistrationVersions, streamWriter }
    },
  }
}
