import { describe, expect, it } from 'vitest'
import {
  imageInputCapability,
  vendorDescriptorFor,
} from './vendorDescriptor'
import { OPENAI_COMPAT_BASE64_IMAGE_INPUT } from './imageCapability'

describe('model-level image capability', () => {
  it('only enables exact models with verified image protocols', () => {
    expect(imageInputCapability('kimi', 'kimi-k3')).toMatchObject({
      kind: 'provider-upload',
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      limits: { maxImages: 8, maxBytesPerImage: 20 * 1024 * 1024 },
    })
    expect(imageInputCapability('kimi', 'future-kimi')).toMatchObject({ kind: 'unsupported' })
    expect(imageInputCapability('deepseek', 'deepseek-v4-pro')).toMatchObject({
      kind: 'unsupported',
    })
    expect(imageInputCapability('deepseek', 'deepseek-flash')).toMatchObject({
      kind: 'provider-upload',
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      limits: { maxImages: 8, maxBytesPerImage: 20 * 1024 * 1024 },
    })
    expect(imageInputCapability('deepseek', 'deepseek-v4-flash-vision-exp')).toMatchObject({
      kind: 'unsupported',
    })
    expect(vendorDescriptorFor('kimi').models['kimi-k3']).toMatchObject({
      contextWindowTokens: 1_000_000,
    })
  })

  it('defines conservative limits for opt-in OpenAI-compatible base64 images', () => {
    expect(OPENAI_COMPAT_BASE64_IMAGE_INPUT).toMatchObject({
      kind: 'inline-base64',
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      limits: { maxImages: 4, maxBytesPerImage: 5 * 1024 * 1024 },
    })
  })
})
