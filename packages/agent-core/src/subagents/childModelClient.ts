import {
  callModel,
  normalizeCacheUsage,
  type ModelChatResponse,
  type ModelFunctionTool,
  type ModelItem,
  type ThinkingConfig,
} from '@web-agent/ai'
import { compactContext, estimateTokensFromText } from '../runtime/contextCompaction'
import type { ContextCacheLane } from '../runtime/contextCache'
import { type ModelSettings } from '../state/core.type'
import type { DelegateAgentCallContext } from './types'
import {
  type DelegationCallState,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
} from './runtimeState'

const CONTEXT_BUDGET_TOKENS = 60_000
const RESERVED_OUTPUT_TOKENS = 8_000
const CONTEXT_SAFETY_MARGIN_RATIO = 0.08
const KEEP_RECENT_TURNS = 1

export interface CallModelObservation {
  context: DelegateAgentCallContext
  archiveBasePath: string
  agentPath: string
  turn: number
  phase: Exclude<ContextCacheLane, 'main'>
}

interface ChildModelRequest {
  messages: ModelItem[]
  tools?: ModelFunctionTool[]
  toolChoice?: 'auto' | 'none'
  settings?: ModelSettings
  observe?: CallModelObservation
}

export type ChildModelCaller = (
  state: DelegationCallState,
  args: ChildModelRequest,
  maxModelCalls?: number,
) => Promise<ModelChatResponse>

function thinkingConfig(settings: ModelSettings): ThinkingConfig | undefined {
  if (settings.thinking === undefined) return undefined
  return { type: settings.thinking ? 'enabled' : 'disabled' }
}

function cacheHitRate(hitTokens?: number, missTokens?: number): number | undefined {
  if (typeof hitTokens !== 'number' || typeof missTokens !== 'number') return undefined
  const total = hitTokens + missTokens
  return total > 0 ? hitTokens / total : undefined
}

export function firstAssistantText(response: ModelChatResponse): string {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

/** Sends compacted child-model requests and records their cache observability events. */
export function createChildModelCaller(runtime: DelegateAgentRuntimeState): ChildModelCaller {
  return async (state, args, maxModelCalls) => {
    const modelCallLimit = maxModelCalls ?? state.rootBudget.maxModelCalls
    const settings = args.settings ?? runtime.opts.settings
    const reservedTokens =
      estimateTokensFromText(JSON.stringify(args.tools ?? []))
      + (settings.max_tokens ?? RESERVED_OUTPUT_TOKENS)
      + Math.ceil(CONTEXT_BUDGET_TOKENS * CONTEXT_SAFETY_MARGIN_RATIO)
    const compaction = compactContext(args.messages, {
      maxTokens: CONTEXT_BUDGET_TOKENS,
      reservedTokens,
      keepRecentTurns: KEEP_RECENT_TURNS,
      replayUnsafeToolNames: runtime.registry.replayUnsafeToolNames(),
    })

    if (args.observe) {
      const { context, archiveBasePath, agentPath, turn, phase } = args.observe
      if (compaction.compacted) {
        await runtime.archive.bestEffortRecordEvent(
          context,
          archiveBasePath,
          'child_context_compacted',
          agentPath,
          {
            turn,
            phase,
            budgetTk: CONTEXT_BUDGET_TOKENS,
            reservedTk: reservedTokens,
            effectiveBudgetTk: compaction.effectiveBudgetTokens,
            estBeforeTk: compaction.estimatedTokensBefore,
            estAfterTk: compaction.estimatedTokensAfter,
            summarizedToolResults: compaction.summarizedToolResults,
            droppedItems: compaction.droppedItems,
            messagesBefore: args.messages.length,
            messagesAfter: compaction.items.length,
            withinBudget: compaction.withinBudget,
          },
        )
      }
      if (!compaction.withinBudget) {
        await runtime.archive.bestEffortRecordEvent(
          context,
          archiveBasePath,
          'child_context_over_budget',
          agentPath,
          {
            turn,
            phase,
            effectiveBudgetTk: compaction.effectiveBudgetTokens,
            estAfterTk: compaction.estimatedTokensAfter,
            compacted: compaction.compacted,
            hint: compaction.compacted
              ? '子 agent 上下文压缩后仍超预算（多半是单条工具正文自己就撑爆了预算），本次请求可能被接口拒绝；请缩小子任务范围或让工具只取所需片段'
              : '子 agent 上下文超预算且无可压缩内容（system/user 均在硬保护范围内），本次请求可能被接口拒绝；请缩短子任务描述或继承的 skill 正文',
          },
        )
      }
    }

    const requestBase = {
      model: settings.model,
      messages: compaction.items,
      temperature: settings.temperature,
      max_tokens: settings.max_tokens,
      thinking: thinkingConfig(settings),
      tools: args.tools,
      tool_choice: args.toolChoice ?? 'auto',
      stream: false,
    }
    const callOptions = {
      apiKey: runtime.opts.apiKey,
      signal: runtime.opts.signal,
      fetchImpl: runtime.opts.fetchImpl,
    }
    const cacheLane = args.observe?.phase ?? 'subagent'
    const systemContent = compaction.items.find((item) => item.role === 'system')?.content ?? ''
    const requestMode = cacheLane.startsWith('distill:')
      ? cacheLane
      : args.toolChoice === 'none'
        ? 'final_synthesis'
        : 'tool_loop'
    const cacheProfile = runtime.contextCacheTracker.observe({
      lane: cacheLane,
      scope: `${runtime.opts.sessionId}:${runtime.opts.runId}:${args.observe?.agentPath ?? 'unobserved'}:${cacheLane}`,
      vendor: settings.vendor,
      model: settings.model,
      messages: compaction.items,
      systemContent,
      tools: args.tools ?? [],
      toolChoice: args.toolChoice ?? 'auto',
      thinking: thinkingConfig(settings)?.type,
      reasoningEffort: settings.reasoning_effort,
      compacted: compaction.compacted,
      requestMode,
    })

    const invoke = () => {
      runtime.reserveModelCall(state, modelCallLimit)
      return callModel({
        ...requestBase,
        settings,
        userId: runtime.opts.deepseekUserId,
      }, callOptions)
    }

    let response: ModelChatResponse
    try {
      response = await state.modelCallLimiter.run(invoke, runtime.opts.signal)
    } catch (error) {
      if (args.observe) {
        await runtime.archive.bestEffortRecordEvent(
          args.observe.context,
          args.observe.archiveBasePath,
          'child_model_usage',
          args.observe.agentPath,
          modelUsageFailureData(error, runtime, settings, args.observe, cacheProfile, compaction),
        )
      }
      throw error
    }

    if (args.observe) {
      const cacheUsage = normalizeCacheUsage(response.usage)
      const hitRate = cacheHitRate(cacheUsage?.hitTokens, cacheUsage?.missTokens)
      const promptTk = response.usage?.prompt_tokens ?? response.usage?.input_tokens
      const completionTk = response.usage?.completion_tokens ?? response.usage?.output_tokens
      await runtime.archive.bestEffortRecordEvent(
        args.observe.context,
        args.observe.archiveBasePath,
        'child_model_usage',
        args.observe.agentPath,
        {
          turn: args.observe.turn,
          phase: args.observe.phase,
          vendor: settings.vendor,
          model: settings.model,
          ...(typeof promptTk === 'number' ? { promptTk } : {}),
          ...(typeof completionTk === 'number' ? { completionTk } : {}),
          ...(typeof response.usage?.total_tokens === 'number' ? { totalTk: response.usage.total_tokens } : {}),
          cacheMetricsStatus: cacheUsage ? 'available' : 'unavailable',
          ...(typeof cacheUsage?.hitTokens === 'number' ? { cacheHitTk: cacheUsage.hitTokens } : {}),
          ...(typeof cacheUsage?.missTokens === 'number' ? { cacheMissTk: cacheUsage.missTokens } : {}),
          ...(cacheUsage?.missSource ? { cacheMissSource: cacheUsage.missSource } : {}),
          ...(typeof cacheUsage?.writeTokens === 'number' ? { cacheWriteTk: cacheUsage.writeTokens } : {}),
          ...(typeof hitRate === 'number' ? { cacheHitRate: hitRate } : {}),
          ...cacheProfileData(cacheProfile, compaction),
        },
      )
    }
    return response
  }
}

function cacheProfileData(
  profile: ReturnType<DelegateAgentRuntimeState['contextCacheTracker']['observe']>,
  compaction: ReturnType<typeof compactContext>,
) {
  return {
    cacheLane: profile.lane,
    cacheProfile: profile.profileId,
    cacheEpoch: profile.epoch,
    cacheEpochReason: profile.epochReason,
    cacheProtocolVersion: profile.protocolVersion,
    laneScopeFingerprint: profile.laneScopeFingerprint,
    systemFingerprint: profile.systemFingerprint,
    requestProjectionFingerprint: profile.requestProjectionFingerprint,
    toolSetFingerprint: profile.toolSetFingerprint,
    compactionBoundary: profile.compactionBoundary,
    contextCompacted: compaction.compacted,
    withinBudget: compaction.withinBudget,
  }
}

function modelUsageFailureData(
  error: unknown,
  runtime: DelegateAgentRuntimeState,
  settings: ModelSettings,
  observe: CallModelObservation,
  profile: ReturnType<DelegateAgentRuntimeState['contextCacheTracker']['observe']>,
  compaction: ReturnType<typeof compactContext>,
) {
  return {
    turn: observe.turn,
    phase: observe.phase,
    vendor: settings.vendor,
    model: settings.model,
    cacheMetricsStatus: isAbortError(error, runtime.opts.signal) ? 'cancelled' : 'request_failed',
    ...cacheProfileData(profile, compaction),
    error: toErrorMessage(error),
  }
}
