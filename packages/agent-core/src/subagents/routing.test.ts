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

  it('routes temporal normalization to Pro', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      taskCategory: 'extraction',
      riskLevel: 'low',
      requiresTemporalNormalization: true,
    })).toEqual({
      tier: 'pro',
      reason: 'temporal_normalization_requires_pro',
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

  it('rejects Flash requests that lack observable safe features', () => {
    expect(routeSubagentModel({
      parentPath: 'root',
      requestedTier: 'flash',
    })).toEqual({
      tier: 'pro',
      reason: 'flash_request_missing_safe_features',
    })
  })

  it('extends Flash eligibility to valid nested paths without relaxing quality gates', () => {
    // Flash 资格只看任务特征，与树深度无关。
    expect(routeSubagentModel({
      parentPath: 'root-01',
      requestedTier: 'flash',
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'flash',
      reason: 'low_risk_retrieval_uses_flash',
    })
    expect(routeSubagentModel({
      parentPath: 'root-02-03',
      taskCategory: 'extraction',
      riskLevel: 'low',
    })).toEqual({
      tier: 'flash',
      reason: 'low_risk_extraction_uses_flash',
    })
    // 质量闸门不因深度豁免：嵌套 + 先前失败仍升级 Pro。
    expect(routeSubagentModel({
      parentPath: 'root-01',
      taskCategory: 'retrieval',
      riskLevel: 'low',
      priorFailureCount: 1,
    }).reason).toBe('prior_failure_requires_pro')
    // 嵌套 + 缺安全特征的 Flash 请求同样被拒。
    expect(routeSubagentModel({
      parentPath: 'root-01',
      requestedTier: 'flash',
    }).reason).toBe('flash_request_missing_safe_features')
  })

  it('fails closed to Pro when the parent path is missing or invalid', () => {
    // 树上下文缺失或伪造时不给 Flash：这是原「嵌套一律 Pro」规则真正要守的东西。
    expect(routeSubagentModel({
      taskCategory: 'retrieval',
      riskLevel: 'low',
    })).toEqual({
      tier: 'pro',
      reason: 'unknown_parent_path_requires_pro',
    })
    for (const bad of ['', 'ROOT', 'root-', 'root-00', 'root-1x', 'node-01']) {
      expect(routeSubagentModel({
        parentPath: bad,
        taskCategory: 'retrieval',
        riskLevel: 'low',
      }).reason).toBe('unknown_parent_path_requires_pro')
    }
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
