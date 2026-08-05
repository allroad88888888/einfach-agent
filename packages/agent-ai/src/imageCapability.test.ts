import { describe, expect, it } from 'vitest'
import {
  imageInputCapability,
  vendorDescriptorFor,
} from './vendorDescriptor'

describe('model-level image capability', () => {
  it('only enables the exact verified Kimi model', () => {
    expect(imageInputCapability('kimi', 'kimi-k2.6')).toMatchObject({
      kind: 'provider-upload',
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      limits: { maxImages: 8, maxBytesPerImage: 20 * 1024 * 1024 },
    })
    expect(imageInputCapability('kimi', 'future-kimi')).toMatchObject({ kind: 'unsupported' })
    expect(imageInputCapability('deepseek', 'deepseek-v4-pro')).toMatchObject({
      kind: 'unsupported',
    })
    expect(vendorDescriptorFor('kimi').models['kimi-k2.6']).toMatchObject({
      contextWindowTokens: 262_144,
    })
  })

})
