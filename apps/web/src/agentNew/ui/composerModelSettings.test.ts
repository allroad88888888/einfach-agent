import {
  getModelThinkingCapability,
  defaultProviderRegistry,
  type ModelThinkingCapability,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import { describe, expect, it } from 'vitest'
import {
  selectComposerModelSettings,
  setComposerThinkingEffort,
  setComposerThinkingEnabled,
} from './composerModelSettings'

function capability(vendor: string, model: string): ModelThinkingCapability {
  return getModelThinkingCapability(defaultProviderRegistry, vendor, model)
}

const REQUIRED_CAPABILITY: ModelThinkingCapability = {
  kind: 'effort',
  sourceUrl: 'https://example.test/required-thinking',
  efforts: ['low', 'high', 'max'],
  required: true,
}

describe('selectComposerModelSettings', () => {
  it('preserves a DeepSeek effort supported by the selected DeepSeek model', () => {
    const current: ModelSettings = {
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'deepseek', model: 'deepseek-v4-flash',
    }, capability('deepseek', 'deepseek-v4-flash'))).toEqual({
      vendor: 'deepseek', model: 'deepseek-v4-flash', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    })
  })

  it('drops a cross-vendor effort while preserving shared settings for GLM', () => {
    const current: ModelSettings = {
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true, temperature: 0.4,
      vendorSettings: { reasoning_effort: 'high' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'glm', model: 'glm-5.3',
    }, capability('glm', 'glm-5.3'))).toEqual({
      vendor: 'glm', model: 'glm-5.3', thinking: true, temperature: 0.4,
    })
  })

  it('keeps Kimi region on a same-vendor selection without a target bag', () => {
    const current: ModelSettings = {
      vendor: 'kimi', model: 'kimi-k3', thinking: true,
      vendorSettings: { region: 'global', reasoning_effort: 'high' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'kimi', model: 'kimi-k3',
    }, capability('kimi', 'kimi-k3'))).toEqual({
      vendor: 'kimi', model: 'kimi-k3', thinking: true,
      vendorSettings: { region: 'global', reasoning_effort: 'high' },
    })
  })

  it('uses a profile target bag exactly and never carries another provider bag', () => {
    const current: ModelSettings = {
      vendor: 'kimi', model: 'kimi-k3', thinking: true,
      vendorSettings: { region: 'cn', reasoning_effort: 'high' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'openai-compat', model: 'remote/model', vendorSettings: { connectionId: 'profile-b' },
    }, capability('openai-compat', 'remote/model'))).toEqual({
      vendor: 'openai-compat', model: 'remote/model', vendorSettings: { connectionId: 'profile-b' },
    })
  })

  it('switches profiles by their target connection identity', () => {
    const current: ModelSettings = {
      vendor: 'openai-compat', model: 'profile-a/model',
      vendorSettings: { connectionId: 'profile-a' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'openai-compat', model: 'profile-b/model', vendorSettings: { connectionId: 'profile-b' },
    }, capability('openai-compat', 'profile-b/model'))).toEqual({
      vendor: 'openai-compat', model: 'profile-b/model', vendorSettings: { connectionId: 'profile-b' },
    })
  })

  it('does not inherit a profile connection for a legacy openai-compatible target', () => {
    const current: ModelSettings = {
      vendor: 'openai-compat', model: 'profile-a/model', thinking: true,
      vendorSettings: { connectionId: 'profile-a' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'openai-compat', model: 'legacy/model',
    }, capability('openai-compat', 'legacy/model'))).toEqual({
      vendor: 'openai-compat', model: 'legacy/model',
    })
  })

  it('overlays an explicit identity bag while retaining legal effort and opaque settings', () => {
    const current: ModelSettings = {
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
      vendorSettings: { connectionId: 'old-identity', reasoning_effort: 'high', userPreference: 'keep' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'deepseek', model: 'deepseek-v4-flash',
      vendorSettings: { connectionId: 'new-identity', targetSetting: 'replace' },
    }, capability('deepseek', 'deepseek-v4-flash'))).toEqual({
      vendor: 'deepseek', model: 'deepseek-v4-flash', thinking: true,
      vendorSettings: {
        connectionId: 'new-identity', reasoning_effort: 'high', userPreference: 'keep', targetSetting: 'replace',
      },
    })
  })

  it('does not leak a prior profile connection to an internal model', () => {
    const current: ModelSettings = {
      vendor: 'openai-compat', model: 'remote/model', thinking: true,
      vendorSettings: { connectionId: 'profile-a', reasoning_effort: 'max' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'deepseek', model: 'deepseek-v4-pro',
    }, capability('deepseek', 'deepseek-v4-pro'))).toEqual({
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
    })
  })

  it('clears Thinking, effort, and empty bags for unknown targets', () => {
    const current: ModelSettings = {
      vendor: 'glm', model: 'glm-5.3', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }

    expect(selectComposerModelSettings(current, {
      vendor: 'other', model: 'unknown',
    }, capability('other', 'unknown'))).toEqual({ vendor: 'other', model: 'unknown' })
  })
})

describe('Thinking setting transitions', () => {
  const glm = capability('glm', 'glm-5.3')

  it('keeps required Thinking enabled without mutating the input', () => {
    const current: ModelSettings = {
      vendor: 'glm', model: 'glm-5.3', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }
    const original = structuredClone(current)

    expect(setComposerThinkingEnabled(current, glm, false)).toEqual(current)
    expect(current).toEqual(original)
  })

  it('represents Auto by deleting the effort and rejects illegal efforts', () => {
    const current: ModelSettings = {
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }
    const deepseek = capability('deepseek', 'deepseek-v4-pro')

    expect(setComposerThinkingEffort(current, deepseek, 'auto')).toEqual({
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
    })
    expect(setComposerThinkingEffort(current, deepseek, 'low')).toEqual({
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
      vendorSettings: { reasoning_effort: 'low' },
    })
  })

  it('materializes only a legal concrete effort from a default-enabled implicit state', () => {
    const deepseek = capability('deepseek', 'deepseek-v4-pro')
    const implicit: ModelSettings = { vendor: 'deepseek', model: 'deepseek-v4-pro' }
    const glm = capability('glm', 'glm-5.3')
    const glmImplicit: ModelSettings = { vendor: 'glm', model: 'glm-5.3' }

    expect(setComposerThinkingEffort(implicit, deepseek, 'max')).toEqual({
      ...implicit, thinking: true, vendorSettings: { reasoning_effort: 'max' },
    })
    expect(setComposerThinkingEffort(glmImplicit, glm, 'high')).toEqual({
      ...glmImplicit, thinking: true, vendorSettings: { reasoning_effort: 'high' },
    })
    expect(setComposerThinkingEffort({ ...implicit, thinking: false }, deepseek, 'max')).toEqual({
      ...implicit, thinking: false, vendorSettings: { reasoning_effort: 'max' },
    })
    expect(setComposerThinkingEffort({ ...implicit, thinking: true }, deepseek, 'max')).toEqual({
      ...implicit, thinking: true, vendorSettings: { reasoning_effort: 'max' },
    })
    expect(setComposerThinkingEffort({
      ...implicit, vendorSettings: { reasoning_effort: 'high' },
    }, deepseek, 'auto')).toEqual(implicit)
    expect(setComposerThinkingEffort(implicit, deepseek, 'low')).toEqual({
      ...implicit, thinking: true, vendorSettings: { reasoning_effort: 'low' },
    })
  })

  it('does not create Thinking fields for an unknown capability', () => {
    const settings: ModelSettings = {
      vendor: 'glm', model: 'glm-5.3', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }

    expect(setComposerThinkingEnabled(settings, capability('other', 'unknown'), true)).toEqual({
      vendor: 'glm', model: 'glm-5.3',
    })
  })

  it('keeps required Thinking enabled across model selection and programmatic updates', () => {
    const selected = selectComposerModelSettings({
      vendor: 'glm', model: 'optional-model', thinking: false,
      vendorSettings: { reasoning_effort: 'high' },
    }, {
      vendor: 'glm', model: 'required-model',
    }, REQUIRED_CAPABILITY)

    expect(selected).toEqual({
      vendor: 'glm', model: 'required-model', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    })
    expect(setComposerThinkingEnabled(selected, REQUIRED_CAPABILITY, false)).toEqual(selected)
    expect(setComposerThinkingEffort({
      vendor: 'glm', model: 'required-model', thinking: false,
    }, REQUIRED_CAPABILITY, 'max')).toEqual({
      vendor: 'glm', model: 'required-model', thinking: true,
      vendorSettings: { reasoning_effort: 'max' },
    })
    expect(setComposerThinkingEffort({
      vendor: 'glm', model: 'required-model', thinking: false,
    }, REQUIRED_CAPABILITY, 'auto')).toEqual({
      vendor: 'glm', model: 'required-model', thinking: true,
    })
  })
})
