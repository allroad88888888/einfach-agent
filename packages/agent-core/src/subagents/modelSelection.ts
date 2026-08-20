import { callWithModelEscalation, type ModelChatResponse } from '@einfach-agent/ai'
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
  /**
   * 触发这次升档的判据结果，由共用判据给出（`@einfach-agent/ai` 的 modelCapacityEscalation）：
   * 容量耗尽时是那个 provider 自报的 finish_reason，请求整体失败时是 `request_failed`。
   * core 不再枚举任何一家的私有终态，故这里是开放字符串而不是闭合 union。
   */
  trigger: string
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

function escalateSelection(
  selection: SubagentModelSelection,
  input: SubagentModelSelectionInput,
): Omit<SubagentModelEscalation, 'trigger'> {
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
  }
}

/**
 * 按当前档位调用模型；「值不值得换模型再来一次」的**判据**共用
 * `@einfach-agent/ai` 的 `callWithModelEscalation`（主 Agent 用的是同一条），
 * 本函数只提供子 Agent 侧的**策略**：升档到哪个模型、什么前提下允许升。
 */
export async function callSelectedSubagentModel(
  args: CallSelectedSubagentModelArgs,
): Promise<ModelChatResponse> {
  return callWithModelEscalation({
    // 每次都重读 selection.settings：escalate 里换完档位，紧接着这次调用就用新模型。
    invoke: () => args.invoke(args.selection.settings),
    signal: args.signal,
    escalate: async (trigger, error) => {
      // 三条前提都是子 Agent 私有的策略，不属于判据：只有低价档值得升、每个子 Agent 至多升
      // 一次，且这一轮必须还没有任何对外可见的动作（确认过的工具 / 改动集 / 已执行工具）——
      // 否则重发会把已经发生过的事再做一遍。
      if (args.selection.routeDecision.tier !== 'flash') return false
      if (args.selection.fallbackCount > 0) return false
      if (!args.canEscalate()) return false
      await args.onEscalated({
        ...escalateSelection(args.selection, args.input),
        trigger,
        ...(error === undefined ? {} : { error: toErrorMessage(error) }),
      })
      return true
    },
  })
}
