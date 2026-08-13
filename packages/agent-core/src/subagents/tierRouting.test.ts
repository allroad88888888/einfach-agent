import { describe, expect, it } from 'vitest'
import type { ModelSettings } from '../state/core.type'
import { createSubagentModelSelection, type SubagentModelSelection } from './modelSelection'
import { ROOT_AGENT_PATH } from './path'
import {
  applySubagentTier,
  subagentTierTarget,
  supportsSubagentTierRouting,
  type SubagentTierRouting,
} from './tierRouting'
import type { DelegateAgentChildSpec } from './types'

// core 不再持有任何默认档位表（那是装配层决策，见 packages/subagents/src/defaultTierRouting.ts）；
// 这两张表只是测试夹具，用来证明契约函数只认注入的表，不认任何厂商专属逻辑。
const DEEPSEEK_TIER_ROUTING: SubagentTierRouting = {
  vendor: 'deepseek',
  models: { pro: 'deepseek-tier-pro', flash: 'deepseek-tier-flash' },
}

const GLM_TIER_ROUTING: SubagentTierRouting = {
  vendor: 'glm',
  models: { pro: 'glm-tier-pro', flash: 'glm-tier-flash' },
}

const LOW_RISK_RETRIEVAL: DelegateAgentChildSpec = {
  objective: 'look up one document',
  taskCategory: 'retrieval',
  riskLevel: 'low',
}

const HIGH_RISK_WORK: DelegateAgentChildSpec = {
  objective: 'edit a cross-module implementation',
  taskCategory: 'implementation',
  riskLevel: 'high',
}

function select(
  primarySettings: ModelSettings,
  spec: DelegateAgentChildSpec,
  tierRouting: SubagentTierRouting,
): SubagentModelSelection {
  return createSubagentModelSelection({
    primarySettings,
    parentPath: ROOT_AGENT_PATH,
    spec,
    confirmedTools: [],
    tierRouting,
  })
}

describe('supportsSubagentTierRouting', () => {
  it('accepts only the exact vendor and models listed in the injected table', () => {
    expect(supportsSubagentTierRouting(
      { vendor: 'deepseek', model: DEEPSEEK_TIER_ROUTING.models.flash },
      DEEPSEEK_TIER_ROUTING,
    )).toBe(true)
    expect(supportsSubagentTierRouting(
      { vendor: 'deepseek', model: 'private-deepseek-gateway-model' },
      DEEPSEEK_TIER_ROUTING,
    )).toBe(false)
    expect(supportsSubagentTierRouting(
      { vendor: 'glm', model: 'glm-tier-flash' },
      DEEPSEEK_TIER_ROUTING,
    )).toBe(false)
    expect(supportsSubagentTierRouting(
      { vendor: 'glm', model: 'glm-tier-flash' },
      GLM_TIER_ROUTING,
    )).toBe(true)
  })

  it('exposes each tier as a vendor and model pair', () => {
    expect(subagentTierTarget(GLM_TIER_ROUTING, 'flash')).toEqual({
      vendor: 'glm',
      model: 'glm-tier-flash',
    })
  })
})

describe('applySubagentTier', () => {
  it('swaps only the model and keeps every other session parameter', () => {
    const settings: ModelSettings = {
      vendor: 'deepseek',
      model: DEEPSEEK_TIER_ROUTING.models.pro,
      thinking: true,
    }
    expect(applySubagentTier(settings, 'flash', DEEPSEEK_TIER_ROUTING)).toEqual({
      vendor: 'deepseek',
      model: DEEPSEEK_TIER_ROUTING.models.flash,
      thinking: true,
    })
  })

  it('returns the parent settings untouched when they are outside the table', () => {
    const settings: ModelSettings = { vendor: 'deepseek', model: 'private-deepseek-gateway-model' }
    expect(applySubagentTier(settings, 'flash', DEEPSEEK_TIER_ROUTING)).toBe(settings)
  })
})

describe('createSubagentModelSelection with an injected tier routing table', () => {
  it('routes low-risk retrieval to the injected flash model of the table vendor', () => {
    const selection = select({ vendor: 'glm', model: 'glm-tier-pro' }, LOW_RISK_RETRIEVAL, GLM_TIER_ROUTING)
    expect(selection.routeDecision).toEqual({ tier: 'flash', reason: 'low_risk_retrieval_uses_flash' })
    expect(selection.settings.model).toBe('glm-tier-flash')
  })

  it('keeps high-risk work on the injected pro model', () => {
    const selection = select({ vendor: 'glm', model: 'glm-tier-flash' }, HIGH_RISK_WORK, GLM_TIER_ROUTING)
    expect(selection.routeDecision).toEqual({ tier: 'pro', reason: 'high_risk_requires_pro' })
    expect(selection.settings.model).toBe('glm-tier-pro')
  })

  it('leaves a session whose vendor the table does not serve on its parent model', () => {
    const selection = select(
      { vendor: 'deepseek', model: DEEPSEEK_TIER_ROUTING.models.flash },
      LOW_RISK_RETRIEVAL,
      GLM_TIER_ROUTING,
    )
    expect(selection.routeDecision).toEqual({
      tier: 'pro',
      reason: 'unrouted_provider_uses_parent_model',
    })
    expect(selection.settings.model).toBe(DEEPSEEK_TIER_ROUTING.models.flash)
  })

  it('routes correctly for an injected DeepSeek-vendor table', () => {
    const selection = select(
      { vendor: 'deepseek', model: DEEPSEEK_TIER_ROUTING.models.pro },
      LOW_RISK_RETRIEVAL,
      DEEPSEEK_TIER_ROUTING,
    )
    expect(selection.routeDecision).toEqual({ tier: 'flash', reason: 'low_risk_retrieval_uses_flash' })
    expect(selection.settings.model).toBe(DEEPSEEK_TIER_ROUTING.models.flash)
  })
})
