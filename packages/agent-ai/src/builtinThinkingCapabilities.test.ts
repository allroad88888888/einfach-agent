import { describe, expect, it } from 'vitest'
import { defaultProviderRegistry } from './builtinProviders'
import { getModelThinkingCapability, modelRequiresThinking } from './modelThinkingCapability'

const EXPECTED_MODELS = [
  ['deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['deepseek', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Experimental'],
  ['glm', 'glm-5.3', 'GLM-5.3'],
  ['glm', 'glm-5.3-flash', 'GLM-5.3-Flash'],
  ['kimi', 'kimi-k3', 'Kimi K3'],
] as const

const SUPPORTED_MODELS = [
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-v4-flash'],
  ['deepseek', 'deepseek-v4-flash-vision-exp'],
  ['glm', 'glm-5.3'],
  ['glm', 'glm-5.3-flash'],
  ['kimi', 'kimi-k3'],
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

  it.each(['glm-5.3', 'glm-5.3-flash'])('%s requires Low, High, or Max Thinking', (model) => {
    expect(Object.keys(defaultProviderRegistry.describe('glm').models)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
    ])
    expect(defaultProviderRegistry.describeModel('glm', model)).toMatchObject({
      contextWindowTokens: 1_000_000,
      imageInput: { kind: 'unsupported' },
    })
    const capability = getModelThinkingCapability(defaultProviderRegistry, 'glm', model)

    expect(capability).toMatchObject({
      kind: 'effort',
      required: true,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    })
    expect(modelRequiresThinking(capability)).toBe(true)
    expect(capability.kind === 'effort' && Object.isFrozen(capability.efforts)).toBe(true)
  })

  it.each(SUPPORTED_MODELS)('%s:%s defaults Thinking to enabled', (vendor, model) => {
    expect(getModelThinkingCapability(defaultProviderRegistry, vendor, model)).toMatchObject({
      defaultEnabled: true,
    })
  })

  it('requires Kimi K3 Thinking with Low, High, Max, and a Max default', () => {
    const capability = getModelThinkingCapability(defaultProviderRegistry, 'kimi', 'kimi-k3')

    expect(defaultProviderRegistry.describe('kimi').contextWindowTokens).toBe(1_000_000)
    expect(defaultProviderRegistry.describeModel('kimi', 'kimi-k3')).toMatchObject({
      contextWindowTokens: 1_000_000,
    })
    expect(capability).toMatchObject({
      kind: 'effort',
      required: true,
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    })
    expect(modelRequiresThinking(capability)).toBe(true)
    expect(capability.kind === 'effort' && Object.isFrozen(capability.efforts)).toBe(true)
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
