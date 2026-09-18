import { describe, expect, it } from 'vitest'
import { DEEPSEEK_VENDOR_ID, defaultProviderRegistry } from './builtinProviders'
import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_LABELS,
  DEEPSEEK_PRO_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
} from './deepseek'
import { DEEPSEEK_FLASH_IMAGE_INPUT } from './imageCapability'

describe('DeepSeek model catalog', () => {
  it('declares V4.1 Flash with 1M context and static image support', () => {
    const descriptor = defaultProviderRegistry.describeModel(
      DEEPSEEK_VENDOR_ID,
      DEEPSEEK_FLASH_MODEL,
    )

    expect(descriptor).toMatchObject({
      displayName: 'DeepSeek V4.1 Flash',
      contextWindowTokens: 1_000_000,
      imageInput: DEEPSEEK_FLASH_IMAGE_INPUT,
      thinking: { kind: 'effort', efforts: ['low', 'high', 'max'] },
    })
    expect(descriptor?.imageInput).toMatchObject({
      kind: 'provider-upload',
      accept: ['image/jpeg', 'image/png', 'image/webp'],
    })
  })

  it('keeps labels in exact lockstep with the provider catalog', () => {
    const models = Object.keys(defaultProviderRegistry.describe(DEEPSEEK_VENDOR_ID).models)

    expect(models.length).toBeGreaterThan(0)
    for (const model of models) expect(DEEPSEEK_MODEL_LABELS[model]).toBeTypeOf('string')
    for (const labelled of Object.keys(DEEPSEEK_MODEL_LABELS)) {
      expect(models).toContain(labelled)
    }
  })

  it('covers the default and pro model display labels', () => {
    expect(DEEPSEEK_MODEL_LABELS[DEFAULT_DEEPSEEK_MODEL]).toBeTypeOf('string')
    expect(DEEPSEEK_MODEL_LABELS[DEEPSEEK_PRO_MODEL]).toBe('DeepSeek V4 Pro')
    expect(DEEPSEEK_MODEL_LABELS[DEEPSEEK_FLASH_MODEL]).toBe('DeepSeek V4.1 Flash')
  })
})
