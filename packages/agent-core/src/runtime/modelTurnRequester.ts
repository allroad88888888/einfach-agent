import { normalizeCacheUsage, streamModel, type ModelChatResponse, type ModelFunctionTool, type ModelItem, type ModelRetryObserver } from '@web-agent/ai'
import { contextCheckpointAtom, itemsAtom } from '../state/sessionAtoms'
import { contextStatsAtom, setContextStats } from '../state/transientAtoms'
import { buildTurnTools, narrowToolCalls, toolSetSchemaFingerprint } from './modelTurn'
import type { CompactionRequestDraft } from './core/plugins/compactionPlugin'
import { contextInputBudgetTokens } from './contextBudget'
import { createContextCheckpoint, contextNeedsDistillation } from './contextDistillation'
import { projectContextCheckpoint } from './contextCheckpointProjection'
import { createContextCacheTracker } from './contextCache'
import { contextProjectionTraceAttrs } from './contextProjectionDiagnostics'
import { contextRequestAssemblyTraceAttrs, snapshotContextRequestAssembly, snapshotContextRequestStage, type RequestControlSource } from './contextRequestAssemblyDiagnostics'
import { injectToolTranscript } from './transcriptInjection'
import { buildContextStatsSnapshot, llmRequestTracePreview, llmTracePreview, responseChars, toolNames, usageStats, usageTraceAttrs, accumulateCacheTotals } from './runLoopTelemetry'
import { refreshVisibleTools } from './toolLoading'
import { nextPlanPinnedTools } from './planToolPins'
import { planIsExecuting } from './toolLoopPlan'
import { createAssistantStreamWriter } from './assistantStreamWriter'
import { abortStatus, safeErrorMessage } from './toolLoopSupport'
import type { ToolLoopBase } from './toolLoopContracts'
import { startSpan, endSpan } from '../observability/trace'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { modelReasoningEffort, modelSamplingSettings } from './modelSettingsProjection'
import { projectTimedToolResultOrphans } from './timedToolResultProjection'

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
  request(turn: number, planStageId: string | undefined, controls: ModelItem[], controlSources?: RequestControlSource[]): Promise<ModelTurnRequestOutcome>
}

/** Builds current-request projections and sends one streaming model request. */
export function createModelTurnRequester(base: ToolLoopBase): ModelTurnRequester {
  const cacheTracker = createContextCacheTracker()
  const thinking = base.settings.thinking === undefined
    ? undefined
    : ({ type: base.settings.thinking ? 'enabled' : 'disabled' } as const)
  const reasoningEffort = modelReasoningEffort(base.settings)
  const sampling = modelSamplingSettings(base.settings)
  const callOptions = { apiKey: base.opts.apiKey, signal: base.opts.signal, fetchImpl: base.opts.fetchImpl }
  return {
    async request(turn, planStageId, controls, controlSources = []) {
      const streamWriter = createAssistantStreamWriter(base.id, base.runId, base.opts.signal, base.core, planStageId)
      // 工具集读面一律走本 run 的 epoch：registry 在 run 中途变了，也不改变已组装给模型的清单。
      base.state.visible = refreshVisibleTools(base.id, base.state.visible, base.core, base.maxTurnTools - 1, base.state.planPinnedTools, base.toolEpoch)
      // P1(2026-08-04 交接):计划执行期已加载工具 pin 住不被 LRU 淘汰,减少 tools 段
      // 来回变化(每变一次 = provider 前缀整段失效);pin 超限淘汰必须落 trace 可审计。
      const planPins = nextPlanPinnedTools({
        planActive: planIsExecuting(base.id, base.core),
        pinned: base.state.planPinnedTools,
        visibleNames: base.state.visible.map((tool) => tool.name),
        isRegistered: (name) => base.toolEpoch.loadSchema(name) !== undefined,
      })
      if (planPins.evicted.length) {
        base.trace.event('tool.plan_pinned_evicted', { tools: planPins.evicted.join(','), max_turn_tools: base.maxTurnTools })
      }
      base.state.planPinnedTools = planPins.pinned
      const tools = buildTurnTools(base.state.visible, base.runtimeIsTauri, { registry: base.toolEpoch, vendor: base.settings.vendor, recentToolNames: base.state.recentToolNames })
      const names = toolNames(tools)
      const exposedRegistrationVersions = new Map<string, number>()
      for (const tool of base.state.visible) {
        if (!tools.some((candidate) => candidate.function.name === tool.name)) continue
        const version = tool.registrationVersion ?? base.toolEpoch.registrationVersion(tool.name)
        if (version !== undefined) exposedRegistrationVersions.set(tool.name, version)
      }
      const sessionStore = base.core.getSessionStore(base.id).store
      const history = sessionStore.getter(itemsAtom)
      const historyItems = history.map((item) => item.item)
      const rawMessages: ModelItem[] = [...base.stablePrefix.items, ...historyItems, ...controls]
      const requestAssembly = snapshotContextRequestAssembly({ rawMessages, stablePrefixItems: base.stablePrefix.items.length, historyItems: historyItems.length, controls, controlSources, tools })
      let projection = projectContextCheckpoint(history, sessionStore.getter(contextCheckpointAtom))
      if (projection.invalidCheckpoint) {
        sessionStore.setter(contextCheckpointAtom, undefined)
        base.trace.event('llm.context_checkpoint_invalidated', { reason: 'covered_history_changed' })
      }
      const inputBudgetTokens = contextInputBudgetTokens(base.settings.vendor, base.settings.model, sampling.maxTokens)
      let projectedMessages: ModelItem[] = [...base.stablePrefix.items, ...projection.messages, ...controls]
      if (contextNeedsDistillation(projectedMessages, tools, inputBudgetTokens)) {
        base.trace.event('llm.context_distillation_started', {
          llm_turn: turn + 1,
          source_messages_count: projection.messages.length,
          input_budget_tk: inputBudgetTokens,
        })
        try {
          const checkpoint = await createContextCheckpoint({
            stablePrefix: base.stablePrefix.items,
            transcript: projection.messages,
            coveredItemIds: history.map((item) => item.id),
            settings: base.settings,
            apiKey: base.opts.apiKey,
            signal: base.opts.signal,
            fetchImpl: base.opts.fetchImpl,
            userId: base.modelUserId,
          })
          if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) {
            return { inactive: true, streamWriter }
          }
          sessionStore.setter(contextCheckpointAtom, checkpoint)
          projection = projectContextCheckpoint(history, checkpoint)
          projectedMessages = [...base.stablePrefix.items, ...projection.messages, ...controls]
          if (contextNeedsDistillation(projectedMessages, tools, inputBudgetTokens)) {
            throw new Error('上下文摘要仍超过本次请求预算；已保留原始历史，请缩小工具 schema 或重试。')
          }
          base.trace.event('llm.context_distillation_succeeded', {
            llm_turn: turn + 1,
            source_messages_count: history.length,
            summary_chars: checkpoint.summary.length,
            source_estimated_tk: checkpoint.sourceEstimatedTokens,
          })
        } catch (error) {
          base.trace.event('llm.context_distillation_failed', { llm_turn: turn + 1, error: safeErrorMessage(error) })
          throw error
        }
      }
      const hasCompactionTimingTools =
        base.core.timedToolRegistrations('preCompact').length > 0 ||
        base.core.timedToolRegistrations('postCompact').length > 0
      const draft: CompactionRequestDraft = {
        messages: projectedMessages,
        tools,
        llmTurn: turn + 1,
        replayUnsafeToolNames: base.toolEpoch.replayUnsafeToolNames(),
        dynamicTailCount: controls.length,
        ...(hasCompactionTimingTools
          ? {
              dispatchTimedItems: async (timing) => {
                const before = sessionStore.getter(itemsAtom).length
                await base.core.dispatchTimedTools({ sessionId: base.id, timing })
                return sessionStore.getter(itemsAtom).slice(before).map(({ item }) => item)
              },
            }
          : {}),
      }
      await base.hooks.transformContext?.(base.pluginContext, draft)
      if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) return { inactive: true, streamWriter }
      const afterTransform = snapshotContextRequestStage(draft.messages)
      try {
        await base.hooks.prepareRequest?.(base.pluginContext, draft)
      } catch (error) {
        base.trace.event('agent.plugin_prepare_request_failed', { error: safeErrorMessage(error) })
        throw error
      }
      if (!base.control.isCurrent() || !base.control.isRunning() || base.opts.signal.aborted) return { inactive: true, streamWriter }
      // timed dispatcher 的结果是 timeline 本体的孤儿 tool item；仅请求投影补齐协议配对，
      // 后续 cache、trace 与 streamModel 因而共享实际发送给模型的同一消息序列。
      const messages = projectTimedToolResultOrphans(draft.messages)
      const requestAssemblyTrace = contextRequestAssemblyTraceAttrs({ assembly: requestAssembly, afterTransform, final: snapshotContextRequestStage(messages) })
      const contextDistilled = projection.checkpoint !== undefined
      const cacheProfile = cacheTracker.observe({ lane: 'main', scope: `${base.id}:${base.runId}:${ROOT_AGENT_PATH}`, vendor: base.settings.vendor, model: base.settings.model, messages, systemContent: base.stablePrefix.content, tools, toolChoice: 'auto', thinking: thinking?.type, reasoningEffort, compacted: contextDistilled, dynamicControls: controls, requestMode: 'tool_loop' })
      const previousTotals = base.core.getSessionStore(base.id).store.getter(contextStatsAtom)?.cacheTotals
      const cacheTotals = previousTotals?.runId === base.runId ? previousTotals : undefined
      const contextStats = buildContextStatsSnapshot({ runId: base.runId, turnId: base.turnId, llmTurn: turn + 1, vendor: base.settings.vendor, model: base.settings.model, messages, tools, cacheProfile, cacheTotals, inputBudgetTokens, estimatedTokensBeforeCompaction: projection.checkpoint?.sourceEstimatedTokens })
      setContextStats(base.id, contextStats, base.core)
      injectToolTranscript(base.id, tools, toolSetSchemaFingerprint(tools), base.core)
      base.trace.event('llm.tools_injected', { tools_count: tools.length, tool_names: names.join(',') })
      base.trace.event('llm.context_snapshot', { llm_turn: contextStats.llmTurn, messages_count: contextStats.messagesCount, tools_count: contextStats.toolsCount, dynamic_controls_count: controls.length, estimated_tokens: contextStats.estimatedTokens, total_chars: contextStats.totalChars, messages_chars: contextStats.messagesChars, tools_chars: contextStats.toolsChars, cache_profile: cacheProfile.profileId, cache_epoch: cacheProfile.epoch, cache_lane: cacheProfile.lane, cache_epoch_reason: cacheProfile.epochReason, cache_epoch_causes: cacheProfile.epochCauses.join(','), cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint, cache_system_fingerprint: cacheProfile.systemFingerprint, cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint, tool_set_fingerprint: cacheProfile.toolSetFingerprint, cache_compaction_boundary: cacheProfile.compactionBoundary, ...contextProjectionTraceAttrs(cacheProfile), ...requestAssemblyTrace })
      const requestBase = { model: base.settings.model, messages, temperature: sampling.temperature, max_tokens: sampling.maxTokens, thinking, tools, tool_choice: 'auto' as const, stream: true }
      let retries = 0
      const llmSpan = startSpan('llm.chat', { kind: 'llm', parent: base.trace.span, attrs: () => ({ sessionId: base.id, runId: base.runId, turnId: base.turnId, llm_turn: contextStats.llmTurn, vendor: base.settings.vendor, model: base.settings.model, messages_count: messages.length, tools_count: tools.length, dynamic_controls_count: controls.length, adapter_retry_attempt: retries, estimated_context_tokens: contextStats.estimatedTokens, context_chars: contextStats.totalChars, tools_chars: contextStats.toolsChars, context_distilled: contextDistilled, context_within_budget: true, cache_profile: cacheProfile.profileId, cache_epoch: cacheProfile.epoch, cache_lane: cacheProfile.lane, cache_epoch_reason: cacheProfile.epochReason, cache_epoch_causes: cacheProfile.epochCauses.join(','), cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint, cache_system_fingerprint: cacheProfile.systemFingerprint, cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint, tool_set_fingerprint: cacheProfile.toolSetFingerprint, ...contextProjectionTraceAttrs(cacheProfile), ...requestAssemblyTrace, requestPreview: llmRequestTracePreview({ ...requestBase, reasoning_effort: reasoningEffort }) }) })
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
      setContextStats(base.id, { ...contextStats, usage: usageStats(response.usage), cache: { ...contextStats.cache!, metricsStatus: responseCacheUsage ? 'available' : 'unavailable' }, cacheTotals: accumulateCacheTotals(cacheTotals, response.usage, base.runId), finishReason: choice?.finish_reason ?? null, responseModel: response.model }, base.core)
      return { response, choice, message, toolCalls, tools, exposedRegistrationVersions, streamWriter }
    },
  }
}
