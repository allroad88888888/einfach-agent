import { describe, expect, it } from 'vitest'
import { routeSubagentModel } from './routing'

describe('routeSubagentModel', () => {
  it('keeps other providers on the configured parent model policy lane', () => {
    expect(routeSubagentModel({
      vendor: 'glm',
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'pro',
      reason: 'non_deepseek_provider_uses_parent_model',
    })
  })

  it('preserves custom DeepSeek models instead of assuming official tier support', () => {
    expect(routeSubagentModel({
      vendor: 'deepseek',
      supportsDeepSeekTierRouting: false,
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'pro',
      reason: 'custom_deepseek_model_uses_parent_model',
    })
  })

  it('routes only observable low-risk retrieval and extraction work to Flash', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'flash',
      reason: 'low_risk_retrieval_uses_flash',
    })
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'extraction',
      riskLevel: 'low',
      requestedTier: 'flash',
    })).toEqual({
      tier: 'flash',
      reason: 'low_risk_extraction_uses_flash',
    })
  })

  it('keeps high-risk, cross-module, final-acceptance, and failed work on Pro', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'high',
    }).reason).toBe('high_risk_requires_pro')
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
      crossModule: true,
    }).reason).toBe('cross_module_requires_pro')
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'verification',
      riskLevel: 'low',
      finalAcceptance: true,
    }).reason).toBe('final_acceptance_requires_pro')
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
      priorFailureCount: 1,
    }).reason).toBe('prior_failure_requires_pro')
  })

  it('rejects unsafe Flash requests and never delegates Flash routing to nested agents', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      requestedTier: 'flash',
    })).toEqual({
      tier: 'pro',
      reason: 'flash_request_missing_safe_features',
    })
    expect(routeSubagentModel({
      parentPath: 'root-01',
      requestedTier: 'flash',
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'pro',
      reason: 'nested_subagent_requires_pro',
    })
  })

  it('keeps dangerous capabilities and evaluator work on Pro', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
      confirmedToolCount: 1,
    }).reason).toBe('dangerous_capability_requires_pro')
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'retrieval',
      riskLevel: 'low',
      mode: 'evaluator',
    }).reason).toBe('evaluator_requires_pro')
  })
})
