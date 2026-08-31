import { describe, expect, it } from 'vitest'
import { defaultProviderRegistry } from './builtinProviders'
import {
  getModelThinkingCapability,
  isDisabledThinkingAlias,
  isSupportedThinkingEffort,
  modelSupportsThinking,
  thinkingEfforts,
} from './modelThinkingCapability'

describe('model Thinking capability queries', () => {
  it('does not inherit the execution fallback for an unknown adapter or model', () => {
    expect(getModelThinkingCapability(
      defaultProviderRegistry,
      'missing-vendor',
      'deepseek-v4-pro',
    )).toEqual({ kind: 'unknown' })
    expect(getModelThinkingCapability(
      defaultProviderRegistry,
      'deepseek',
      'missing-model',
    )).toEqual({ kind: 'unknown' })
    expect(getModelThinkingCapability(
      defaultProviderRegistry,
      'openai-compat',
      'deepseek-v4-pro',
    )).toEqual({ kind: 'unknown' })
  })

  it('distinguishes unsupported, toggle, effort, and unknown models', () => {
    const unsupported = getModelThinkingCapability(
      defaultProviderRegistry,
      'glm',
      'glm-4-long',
    )
    const toggle = getModelThinkingCapability(defaultProviderRegistry, 'kimi', 'kimi-k2.6')
    const effort = getModelThinkingCapability(defaultProviderRegistry, 'glm', 'glm-5.2')
    const unknown = getModelThinkingCapability(defaultProviderRegistry, 'glm', 'future-model')

    expect(unsupported.kind).toBe('unsupported')
    expect(toggle.kind).toBe('toggle')
    expect(effort.kind).toBe('effort')
    expect(unknown.kind).toBe('unknown')
    expect(modelSupportsThinking(unsupported)).toBe(false)
    expect(modelSupportsThinking(toggle)).toBe(true)
    expect(modelSupportsThinking(effort)).toBe(true)
    expect(modelSupportsThinking(unknown)).toBe(false)
  })

  it('validates only declared positive efforts and keeps Auto out of the wire union', () => {
    const glm = getModelThinkingCapability(defaultProviderRegistry, 'glm', 'glm-5.2')
    const kimi = getModelThinkingCapability(defaultProviderRegistry, 'kimi', 'kimi-k2.6')

    expect(isSupportedThinkingEffort(glm, 'xhigh')).toBe(true)
    expect(isSupportedThinkingEffort(glm, 'auto')).toBe(false)
    expect(isSupportedThinkingEffort(glm, 'minimal')).toBe(false)
    expect(isSupportedThinkingEffort(kimi, 'high')).toBe(false)
    expect(isDisabledThinkingAlias(glm, 'minimal')).toBe(true)
    expect(isDisabledThinkingAlias(glm, 'none')).toBe(true)
    expect(thinkingEfforts(kimi)).toEqual([])
  })
})
