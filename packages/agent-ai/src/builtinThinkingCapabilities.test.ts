import { describe, expect, it } from 'vitest'
import { defaultProviderRegistry } from './builtinProviders'
import { getModelThinkingCapability } from './modelThinkingCapability'

const EXPECTED_MODELS = [
  ['deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Experimental'],
  ['glm', 'glm-5.2', 'GLM-5.2'],
  ['glm', 'glm-5.1', 'GLM-5.1'],
  ['glm', 'glm-5', 'GLM-5'],
  ['glm', 'glm-5-turbo', 'GLM-5-Turbo'],
  ['glm', 'glm-4.7', 'GLM-4.7'],
  ['glm', 'glm-4.7-flashx', 'GLM-4.7-FlashX'],
  ['glm', 'glm-4.7-flash', 'GLM-4.7-Flash'],
  ['glm', 'glm-4.6', 'GLM-4.6'],
  ['glm', 'glm-4.5-air', 'GLM-4.5-Air'],
  ['glm', 'glm-4.5-airx', 'GLM-4.5-AirX'],
  ['glm', 'glm-4.5-flash', 'GLM-4.5-Flash'],
  ['glm', 'glm-4-long', 'GLM-4-Long'],
  ['glm', 'glm-4-flashx-250414', 'GLM-4-FlashX-250414'],
  ['glm', 'glm-4-flash-250414', 'GLM-4-Flash-250414'],
  ['kimi', 'kimi-k2.6', 'Kimi K2.6'],
] as const

const GLM_TOGGLE_MODELS = [
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.7-flashx',
  'glm-4.7-flash',
  'glm-4.6',
  'glm-4.5-air',
  'glm-4.5-airx',
  'glm-4.5-flash',
] as const

const SUPPORTED_MODELS = [
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-v4-flash'],
  ['deepseek', 'deepseek-v4-flash-vision-exp'],
  ['glm', 'glm-5.2'],
  ...GLM_TOGGLE_MODELS.map((model) => ['glm', model] as const),
  ['kimi', 'kimi-k2.6'],
] as const

describe('built-in Thinking capability catalog', () => {
  it('enumerates every built-in model in stable order with a display name', () => {
    const first = defaultProviderRegistry.listModels()
    const second = defaultProviderRegistry.listModels()
    const projected = first.map(({ vendor, model, displayName }) => [vendor, model, displayName])

    expect(projected).toEqual(EXPECTED_MODELS)
    expect(second.map(({ vendor, model }) => [vendor, model])).toEqual(
      first.map(({ vendor, model }) => [vendor, model]),
    )
    expect(Object.isFrozen(first)).toBe(true)
    expect(first.every(Object.isFrozen)).toBe(true)
  })

  it.each(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])(
    '%s exposes only Low, High, and Max',
    (model) => {
    const capability = getModelThinkingCapability(defaultProviderRegistry, 'deepseek', model)

    expect(capability).toMatchObject({
      kind: 'effort',
      efforts: ['low', 'high', 'max'],
      effortMappings: { low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max' },
    })
    expect(capability.kind === 'effort' ? capability.efforts : []).not.toEqual(
      expect.arrayContaining(['medium', 'xhigh']),
    )
    expect(capability.kind === 'effort' && Object.isFrozen(capability.efforts)).toBe(true)
    expect(capability.kind === 'effort' ? capability.sourceUrl : '').toMatch(/^https:\/\//)
    },
  )

  it('keeps GLM-5.2 positive effort order separate from disabled protocol aliases', () => {
    const capability = getModelThinkingCapability(defaultProviderRegistry, 'glm', 'glm-5.2')

    expect(capability).toMatchObject({
      kind: 'effort',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      effortMappings: { low: 'high', medium: 'high', xhigh: 'max' },
      disabledAliases: ['minimal', 'none'],
    })
    expect(capability.kind === 'effort' ? capability.efforts : []).not.toEqual(
      expect.arrayContaining(['minimal', 'none']),
    )
  })

  it.each(GLM_TOGGLE_MODELS)('%s is toggle-only', (model) => {
    expect(getModelThinkingCapability(defaultProviderRegistry, 'glm', model)).toMatchObject({
      kind: 'toggle',
    })
  })

  it.each(SUPPORTED_MODELS)('%s:%s defaults Thinking to enabled', (vendor, model) => {
    expect(getModelThinkingCapability(defaultProviderRegistry, vendor, model)).toMatchObject({
      defaultEnabled: true,
    })
  })

  it.each(['glm-4-long', 'glm-4-flashx-250414', 'glm-4-flash-250414'])(
    '%s does not offer a Thinking control',
    (model) => {
      expect(getModelThinkingCapability(defaultProviderRegistry, 'glm', model)).toMatchObject({
        kind: 'unsupported',
      })
      expect(getModelThinkingCapability(defaultProviderRegistry, 'glm', model)).not.toHaveProperty(
        'defaultEnabled',
      )
    },
  )

  it('keeps Kimi K2.6 toggle-only without a fabricated effort list', () => {
    const capability = getModelThinkingCapability(defaultProviderRegistry, 'kimi', 'kimi-k2.6')

    expect(capability).toMatchObject({ kind: 'toggle' })
    expect(capability).not.toHaveProperty('efforts')
    expect(capability).not.toHaveProperty('defaultEffort')
  })

  it('keeps unknown models without a declared Thinking default', () => {
    expect(
      getModelThinkingCapability(defaultProviderRegistry, 'openai-compat', 'unreviewed-model'),
    ).toMatchObject({ kind: 'unknown' })
    expect(
      getModelThinkingCapability(defaultProviderRegistry, 'openai-compat', 'unreviewed-model'),
    ).not.toHaveProperty('defaultEnabled')
  })
})
