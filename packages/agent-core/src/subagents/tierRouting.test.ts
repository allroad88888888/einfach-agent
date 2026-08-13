import { describe, expect, it } from 'vitest'
import type { ModelSettings } from '../state/core.type'
import { DEFAULT_SUBAGENT_TIER_ROUTING } from './defaultTierRouting'
import { createSubagentModelSelection, type SubagentModelSelection } from './modelSelection'
import { ROOT_AGENT_PATH } from './path'
import {
  applySubagentTier,
  subagentTierTarget,
  supportsSubagentTierRouting,
  type SubagentTierRouting,
} from './tierRouting'
import type { DelegateAgentChildSpec } from './types'

// 一张与默认表不同 vendor 的档位表：用来证明档位路由确实由注入决定，
// 而不是换了个写法的 DeepSeek 专用逻辑。
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
      { vendor: 'deepseek', model: DEFAULT_SUBAGENT_TIER_ROUTING.models.flash },
      DEFAULT_SUBAGENT_TIER_ROUTING,
    )).toBe(true)
    expect(supportsSubagentTierRouting(
      { vendor: 'deepseek', model: 'private-deepseek-gateway-model' },
      DEFAULT_SUBAGENT_TIER_ROUTING,
    )).toBe(false)
    expect(supportsSubagentTierRouting(
      { vendor: 'glm', model: 'glm-tier-flash' },
      DEFAULT_SUBAGENT_TIER_ROUTING,
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
      model: DEFAULT_SUBAGENT_TIER_ROUTING.models.pro,
      thinking: true,
    }
    expect(applySubagentTier(settings, 'flash', DEFAULT_SUBAGENT_TIER_ROUTING)).toEqual({
      vendor: 'deepseek',
      model: DEFAULT_SUBAGENT_TIER_ROUTING.models.flash,
      thinking: true,
    })
  })

  it('returns the parent settings untouched when they are outside the table', () => {
    const settings: ModelSettings = { vendor: 'deepseek', model: 'private-deepseek-gateway-model' }
    expect(applySubagentTier(settings, 'flash', DEFAULT_SUBAGENT_TIER_ROUTING)).toBe(settings)
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
      { vendor: 'deepseek', model: DEFAULT_SUBAGENT_TIER_ROUTING.models.flash },
      LOW_RISK_RETRIEVAL,
      GLM_TIER_ROUTING,
    )
    expect(selection.routeDecision).toEqual({
      tier: 'pro',
      reason: 'non_deepseek_provider_uses_parent_model',
    })
    expect(selection.settings.model).toBe(DEFAULT_SUBAGENT_TIER_ROUTING.models.flash)
  })

  it('preserves the shipped default routing for a DeepSeek session', () => {
    const selection = select(
      { vendor: 'deepseek', model: DEFAULT_SUBAGENT_TIER_ROUTING.models.pro },
      LOW_RISK_RETRIEVAL,
      DEFAULT_SUBAGENT_TIER_ROUTING,
    )
    expect(selection.routeDecision).toEqual({ tier: 'flash', reason: 'low_risk_retrieval_uses_flash' })
    expect(selection.settings.model).toBe(DEFAULT_SUBAGENT_TIER_ROUTING.models.flash)
  })
})
