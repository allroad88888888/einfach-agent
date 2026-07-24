import { ROOT_AGENT_PATH } from './path'
import type {
  SubagentModelTier,
  SubagentRiskLevel,
  SubagentTaskCategory,
} from './types'

export type SubagentRouteReason =
  | 'non_deepseek_provider_uses_parent_model'
  | 'custom_deepseek_model_uses_parent_model'
  | 'nested_subagent_requires_pro'
  | 'prior_failure_requires_pro'
  | 'final_acceptance_requires_pro'
  | 'dangerous_capability_requires_pro'
  | 'cross_module_requires_pro'
  | 'high_risk_requires_pro'
  | 'evaluator_requires_pro'
  | 'explicit_pro'
  | 'low_risk_retrieval_uses_flash'
  | 'low_risk_extraction_uses_flash'
  | 'flash_request_missing_safe_features'
  | 'default_pro'

export interface SubagentRouteFeatures {
  vendor?: 'deepseek' | 'glm'
  supportsDeepSeekTierRouting?: boolean
  parentPath?: string
  requestedTier?: SubagentModelTier
  taskCategory?: SubagentTaskCategory
  riskLevel?: SubagentRiskLevel
  crossModule?: boolean
  finalAcceptance?: boolean
  priorFailureCount?: number
  mode?: string
  confirmedToolCount?: number
}

export interface SubagentRouteDecision {
  tier: SubagentModelTier
  reason: SubagentRouteReason
}

/**
 * Pure, deterministic model routing for child agents.
 *
 * It intentionally consumes structured, observable features only. In particular, it does not
 * classify free-form objectives with keyword matching, so the same task metadata always produces
 * the same auditable decision.
 */
export function routeSubagentModel(features: SubagentRouteFeatures): SubagentRouteDecision {
  // Pro / Flash are routing policy lanes. Other providers stay on the conservative lane while
  // retaining their configured parent model.
  if (features.vendor !== undefined && features.vendor !== 'deepseek') {
    return { tier: 'pro', reason: 'non_deepseek_provider_uses_parent_model' }
  }
  // Private gateways and future custom DeepSeek model names are not assumed to implement the
  // official Pro/Flash SKUs. Preserve the configured model instead of silently substituting one.
  if (features.vendor === 'deepseek' && features.supportsDeepSeekTierRouting === false) {
    return { tier: 'pro', reason: 'custom_deepseek_model_uses_parent_model' }
  }
  if (features.parentPath !== ROOT_AGENT_PATH) {
    return { tier: 'pro', reason: 'nested_subagent_requires_pro' }
  }
  if ((features.priorFailureCount ?? 0) > 0) {
    return { tier: 'pro', reason: 'prior_failure_requires_pro' }
  }
  if (features.finalAcceptance || features.taskCategory === 'final_acceptance') {
    return { tier: 'pro', reason: 'final_acceptance_requires_pro' }
  }
  if ((features.confirmedToolCount ?? 0) > 0) {
    return { tier: 'pro', reason: 'dangerous_capability_requires_pro' }
  }
  if (features.crossModule) {
    return { tier: 'pro', reason: 'cross_module_requires_pro' }
  }
  if (features.riskLevel === 'high') {
    return { tier: 'pro', reason: 'high_risk_requires_pro' }
  }
  if (features.mode === 'evaluator') {
    return { tier: 'pro', reason: 'evaluator_requires_pro' }
  }
  if (features.requestedTier === 'pro') {
    return { tier: 'pro', reason: 'explicit_pro' }
  }

  if (features.riskLevel === 'low' && features.taskCategory === 'retrieval') {
    return { tier: 'flash', reason: 'low_risk_retrieval_uses_flash' }
  }
  if (features.riskLevel === 'low' && features.taskCategory === 'extraction') {
    return { tier: 'flash', reason: 'low_risk_extraction_uses_flash' }
  }

  if (features.requestedTier === 'flash') {
    return { tier: 'pro', reason: 'flash_request_missing_safe_features' }
  }
  return { tier: 'pro', reason: 'default_pro' }
}
