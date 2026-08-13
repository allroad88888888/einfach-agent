import type { ModelChatResponse } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'
import {
  routeSubagentModel,
  type SubagentRouteDecision,
} from './routing'
import {
  applySubagentTier,
  supportsSubagentTierRouting,
  type SubagentTierRouting,
} from './tierRouting'
import type { DelegateAgentChildSpec } from './types'

export interface SubagentModelSelectionInput {
  primarySettings: ModelSettings
  parentPath: string | undefined
  spec: DelegateAgentChildSpec
  confirmedTools: readonly string[]
  /**
   * 档位路由表，由装配层经 delegation ports 注入（默认表在
   * `packages/subagents/src/defaultTierRouting.ts`）。core 不持有默认值。
   */
  tierRouting: SubagentTierRouting
}

export interface SubagentModelSelection {
  routeDecision: SubagentRouteDecision
  settings: ModelSettings
  fallbackCount: number
}

export interface SubagentModelEscalation {
  fromRoute: SubagentRouteDecision
  fromModel: string
  toRoute: SubagentRouteDecision
  toModel: string
  fallbackCount: number
  trigger: 'insufficient_system_resource' | 'request_failed'
  error?: string
}

interface CallSelectedSubagentModelArgs {
  selection: SubagentModelSelection
  input: SubagentModelSelectionInput
  signal: AbortSignal
  invoke(settings: ModelSettings): Promise<ModelChatResponse>
  canEscalate(): boolean
  onEscalated(escalation: SubagentModelEscalation): Promise<void>
}

export function routeChildModel(input: SubagentModelSelectionInput): SubagentRouteDecision {
  const { primarySettings, spec } = input
  return routeSubagentModel({
    vendor: primarySettings.vendor,
    tierRoutingVendor: input.tierRouting.vendor,
    supportsTierRouting: supportsSubagentTierRouting(primarySettings, input.tierRouting),
    parentPath: input.parentPath,
    requestedTier: spec.modelTier,
    taskCategory: spec.taskCategory,
    riskLevel: spec.riskLevel,
    crossModule: spec.crossModule,
    requiresTemporalNormalization: spec.requiresTemporalNormalization,
    finalAcceptance: spec.finalAcceptance,
    priorFailureCount: spec.priorFailureCount,
    mode: spec.mode,
    confirmedToolCount: input.confirmedTools.length,
  })
}

export function createSubagentModelSelection(
  input: SubagentModelSelectionInput,
): SubagentModelSelection {
  const routeDecision = routeChildModel(input)
  return {
    routeDecision,
    settings: applySubagentTier(input.primarySettings, routeDecision.tier, input.tierRouting),
    fallbackCount: 0,
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

function isDeterministicModelRequestError(error: unknown): boolean {
  const match = /^Chat completion returned (\d{3})(?:\b|:)/.exec(toErrorMessage(error))
  if (!match) return false
  const status = Number(match[1])
  return status === 400 || status === 401 || status === 402 || status === 422
}

function hasAssistantPayload(response: ModelChatResponse): boolean {
  const message = response.choices?.[0]?.message
  return (
    (typeof message?.content === 'string' && message.content.length > 0)
    || (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0)
    // Raw presence matters: malformed calls are attempted output and must never be replayed only
    // because the runtime cannot dispatch them after narrowing.
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  )
}

function escalateSelection(
  selection: SubagentModelSelection,
  input: SubagentModelSelectionInput,
): SubagentModelEscalation {
  const fromRoute = selection.routeDecision
  const fromModel = selection.settings.model
  selection.fallbackCount = 1
  selection.routeDecision = routeChildModel({
    ...input,
    spec: {
      ...input.spec,
      priorFailureCount: Math.max(1, (input.spec.priorFailureCount ?? 0) + 1),
    },
  })
  selection.settings = applySubagentTier(
    input.primarySettings,
    selection.routeDecision.tier,
    input.tierRouting,
  )
  return {
    fromRoute,
    fromModel,
    toRoute: selection.routeDecision,
    toModel: selection.settings.model,
    fallbackCount: selection.fallbackCount,
    trigger: 'request_failed',
  }
}

export async function callSelectedSubagentModel(
  args: CallSelectedSubagentModelArgs,
): Promise<ModelChatResponse> {
  const invoke = () => args.invoke(args.selection.settings)
  const escalateOnce = async (
    trigger: SubagentModelEscalation['trigger'],
    error?: unknown,
  ): Promise<ModelChatResponse> => {
    const escalation = escalateSelection(args.selection, args.input)
    await args.onEscalated({
      ...escalation,
      trigger,
      ...(error === undefined ? {} : { error: toErrorMessage(error) }),
    })
    return invoke()
  }

  try {
    const response = await invoke()
    const finishReason = response.choices?.[0]?.finish_reason
    if (
      args.selection.routeDecision.tier === 'flash'
      && args.selection.fallbackCount === 0
      && finishReason === 'insufficient_system_resource'
      && !hasAssistantPayload(response)
      && args.canEscalate()
    ) {
      return escalateOnce('insufficient_system_resource')
    }
    return response
  } catch (error) {
    if (
      args.selection.routeDecision.tier !== 'flash'
      || args.selection.fallbackCount > 0
      || isAbortError(error, args.signal)
      || isDeterministicModelRequestError(error)
      || !args.canEscalate()
    ) {
      throw error
    }
    return escalateOnce('request_failed', error)
  }
}
