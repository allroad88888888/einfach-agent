import {
  callModel,
  normalizeCacheUsage,
  type ModelChatResponse,
  type ModelFunctionTool,
  type ModelItem,
  type ThinkingConfig,
} from '@einfach-agent/ai'
import type { ContextCacheLane } from '../runtime/contextCache'
import { CONTEXT_SAFETY_MARGIN_RATIO, DEFAULT_RESERVED_OUTPUT_TOKENS } from '../runtime/contextBudget'
import { contextNeedsDistillation } from '../runtime/contextDistillation'
import { buildContextDistillationMessages, CONTEXT_DISTILLATION_MAX_TOKENS } from '../runtime/contextDistillationPrompt'
import { parseContextDistillationResponse } from '../runtime/contextDistillationResult'
import { type ModelSettings } from '../state/core.type'
import {
  createChildContextCheckpoint,
  projectChildContextCheckpoint,
  type ChildContextCheckpoint,
} from './childContextCheckpoint'
import type { DelegateAgentCallContext } from './types'
import {
  type DelegationCallState,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
} from './runtimeState'
import {
  modelAdapterSettings,
  modelReasoningEffort,
  modelSamplingSettings,
} from '../runtime/modelSettingsProjection'
import { projectTimedToolResultOrphans } from '../runtime/timedToolResultProjection'

const CHILD_CONTEXT_TARGET_TOKENS = 60_000

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
  contextCheckpoint?: ChildContextCheckpoint
  onContextCheckpoint?: (checkpoint: ChildContextCheckpoint | undefined) => void
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

/** Sends child-model requests, creating a model-authored checkpoint only when needed. */
export function createChildModelCaller(runtime: DelegateAgentRuntimeState): ChildModelCaller {
  return async (state, args, maxModelCalls) => {
    const modelCallLimit = maxModelCalls ?? state.rootBudget.maxModelCalls
    const settings = args.settings ?? runtime.opts.settings
    const sampling = modelSamplingSettings(settings)
    const inputBudgetTokens = Math.max(
      0,
      CHILD_CONTEXT_TARGET_TOKENS
        - (sampling.maxTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS)
        - Math.ceil(CHILD_CONTEXT_TARGET_TOKENS * CONTEXT_SAFETY_MARGIN_RATIO),
    )
    let projection = projectChildContextCheckpoint(args.messages, args.contextCheckpoint)
    if (projection.invalidCheckpoint) args.onContextCheckpoint?.(undefined)
    if (contextNeedsDistillation(projection.messages, args.tools ?? [], inputBudgetTokens)) {
      await recordContextDistillationEvent(runtime, args.observe, 'child_context_distillation_started', {
        sourceMessages: projection.messages.length,
        inputBudgetTk: inputBudgetTokens,
      })
      try {
        const checkpointResponse = await state.modelCallLimiter.run(() => {
          runtime.reserveModelCall(state, modelCallLimit)
          return callModel({
            model: settings.model,
            messages: projectTimedToolResultOrphans(
              buildContextDistillationMessages([], projection.messages),
            ),
            // 固定采样参数的 provider 由自家 adapter 丢弃 temperature，core 不写厂商分支。
            temperature: 0,
            max_tokens: CONTEXT_DISTILLATION_MAX_TOKENS,
            stream: false,
            settings: modelAdapterSettings(settings),
            userId: runtime.opts.modelUserId,
          }, {
            apiKey: runtime.opts.apiKey,
            signal: runtime.opts.signal,
            fetchImpl: runtime.opts.fetchImpl,
          })
        }, runtime.opts.signal)
        const summary = parseContextDistillationResponse(checkpointResponse)
        if (!summary) throw new Error('子 agent 上下文摘要未返回有效内容；已保留原始历史。')
        const checkpoint = createChildContextCheckpoint(args.messages, summary)
        args.onContextCheckpoint?.(checkpoint)
        projection = projectChildContextCheckpoint(args.messages, checkpoint)
        if (contextNeedsDistillation(projection.messages, args.tools ?? [], inputBudgetTokens)) {
          throw new Error('子 agent 上下文摘要仍超过请求预算；请缩小工具 schema 或子任务范围。')
        }
        await recordContextDistillationEvent(runtime, args.observe, 'child_context_distillation_succeeded', {
          sourceMessages: args.messages.length,
          summaryChars: checkpoint.summary.length,
          sourceEstimatedTk: checkpoint.sourceEstimatedTokens,
        })
      } catch (error) {
        await recordContextDistillationEvent(runtime, args.observe, 'child_context_distillation_failed', {
          error: toErrorMessage(error),
        })
        throw error
      }
    }
    const messages = projection.messages
    const contextDistilled = projection.checkpoint !== undefined

    const requestBase = {
      model: settings.model,
      messages,
      temperature: sampling.temperature,
      max_tokens: sampling.maxTokens,
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
    const systemContent = messages.find((item) => item.role === 'system')?.content ?? ''
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
      messages,
      systemContent,
      tools: args.tools ?? [],
      toolChoice: args.toolChoice ?? 'auto',
      thinking: thinkingConfig(settings)?.type,
      reasoningEffort: modelReasoningEffort(settings),
      compacted: contextDistilled,
      requestMode,
    })

    const invoke = () => {
      runtime.reserveModelCall(state, modelCallLimit)
      return callModel({
        ...requestBase,
        settings: modelAdapterSettings(settings),
        userId: runtime.opts.modelUserId,
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
          modelUsageFailureData(error, runtime, settings, args.observe, cacheProfile, contextDistilled),
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
          ...cacheProfileData(cacheProfile, contextDistilled),
        },
      )
    }
    return response
  }
}

function cacheProfileData(
  profile: ReturnType<DelegateAgentRuntimeState['contextCacheTracker']['observe']>,
  contextDistilled: boolean,
) {
  return {
    cacheLane: profile.lane,
    cacheProfile: profile.profileId,
    cacheEpoch: profile.epoch,
    cacheEpochReason: profile.epochReason,
    cacheEpochCauses: profile.epochCauses.join(','),
    cacheProtocolVersion: profile.protocolVersion,
    laneScopeFingerprint: profile.laneScopeFingerprint,
    systemFingerprint: profile.systemFingerprint,
    requestProjectionFingerprint: profile.requestProjectionFingerprint,
    toolSetFingerprint: profile.toolSetFingerprint,
    compactionBoundary: profile.compactionBoundary,
    contextDistilled,
    withinBudget: true,
  }
}

function modelUsageFailureData(
  error: unknown,
  runtime: DelegateAgentRuntimeState,
  settings: ModelSettings,
  observe: CallModelObservation,
  profile: ReturnType<DelegateAgentRuntimeState['contextCacheTracker']['observe']>,
  contextDistilled: boolean,
) {
  return {
    turn: observe.turn,
    phase: observe.phase,
    vendor: settings.vendor,
    model: settings.model,
    cacheMetricsStatus: isAbortError(error, runtime.opts.signal) ? 'cancelled' : 'request_failed',
    ...cacheProfileData(profile, contextDistilled),
    error: toErrorMessage(error),
  }
}

async function recordContextDistillationEvent(
  runtime: DelegateAgentRuntimeState,
  observe: CallModelObservation | undefined,
  type: 'child_context_distillation_started' | 'child_context_distillation_succeeded' | 'child_context_distillation_failed',
  data: Record<string, unknown>,
): Promise<void> {
  if (!observe) return
  await runtime.archive.bestEffortRecordEvent(
    observe.context,
    observe.archiveBasePath,
    type,
    observe.agentPath,
    { turn: observe.turn, phase: observe.phase, ...data },
  )
}
