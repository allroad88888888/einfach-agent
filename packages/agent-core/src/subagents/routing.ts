import { isAgentPath } from './path'
import type { ModelVendor } from '../state/core.type'
import type {
  SubagentModelTier,
  SubagentRiskLevel,
  SubagentTaskCategory,
} from './types'

/**
 * 归档 `route_reason` 的稳定聚合标识。
 *
 * 前两项曾把厂商名写死在取值里，去专名化后语义不变、只换了措辞。归档读回侧
 * （`@einfach-agent/subagents` 的 replay 与 CLI 复盘脚本）把该字段当不透明字符串透传，不做枚举
 * 校验，所以老归档照常回放；旧值到新值的对照与回放夹具见
 * `packages/subagents/src/archive/replayRouteReason.test.ts`，跨版本聚合时按该对照合并即可。
 */
export type SubagentRouteReason =
  | 'unrouted_provider_uses_parent_model'
  | 'custom_model_uses_parent_model'
  | 'unknown_parent_path_requires_pro'
  | 'prior_failure_requires_pro'
  | 'final_acceptance_requires_pro'
  | 'dangerous_capability_requires_pro'
  | 'cross_module_requires_pro'
  | 'high_risk_requires_pro'
  | 'evaluator_requires_pro'
  | 'temporal_normalization_requires_pro'
  | 'explicit_pro'
  | 'low_risk_retrieval_uses_flash'
  | 'low_risk_extraction_uses_flash'
  | 'flash_request_missing_safe_features'
  | 'default_pro'

export interface SubagentRouteFeatures {
  /** 会话配置的 vendor id；只与 `tierRoutingVendor` 比对，本模块不认识任何具体厂商。 */
  vendor?: ModelVendor
  /** 注入的档位路由表所服务的 vendor id；与 `vendor` 不同即说明该会话不在档位表覆盖范围内。 */
  tierRoutingVendor?: ModelVendor
  /** 会话配置的模型是否正好是档位表里的某个档位 SKU；false = 表外的自定义/私有模型。 */
  supportsTierRouting?: boolean
  parentPath?: string
  requestedTier?: SubagentModelTier
  taskCategory?: SubagentTaskCategory
  riskLevel?: SubagentRiskLevel
  crossModule?: boolean
  requiresTemporalNormalization?: boolean
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
  // Pro / Flash are routing policy lanes. A session whose vendor is not the one the injected tier
  // table serves stays on the conservative lane while retaining its configured parent model.
  if (
    features.vendor !== undefined
    && features.tierRoutingVendor !== undefined
    && features.vendor !== features.tierRoutingVendor
  ) {
    return { tier: 'pro', reason: 'unrouted_provider_uses_parent_model' }
  }
  // Private gateways and future custom model names are not assumed to implement the tier SKUs.
  // Preserve the configured model instead of silently substituting one.
  if (features.supportsTierRouting === false) {
    return { tier: 'pro', reason: 'custom_model_uses_parent_model' }
  }
  // parentPath 缺失或非法说明调用方丢失（或伪造）了树上下文，fail-closed 走 Pro。
  // 合法的嵌套 path（root-01 等）不再一律强制 Pro：Flash 资格只看任务特征，与深度无关
  // ——低风险检索/提取在任意层级都可享受 Flash 价差；而质量闸门（先前失败、evaluator、
  // 危险能力、跨模块、时间归一化……）本就与深度无关，照常生效。
  if (features.parentPath === undefined || !isAgentPath(features.parentPath)) {
    return { tier: 'pro', reason: 'unknown_parent_path_requires_pro' }
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
  if (features.requiresTemporalNormalization) {
    return { tier: 'pro', reason: 'temporal_normalization_requires_pro' }
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
