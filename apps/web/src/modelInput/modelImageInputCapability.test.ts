import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageInputCapabilityForApp } from './modelImageInputCapability'

describe('application image input capability', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('requires an exact OpenAI-compatible session opt-in', () => {
    expect(imageInputCapabilityForApp({
      vendor: 'openai-compat', model: 'vision',
      vendorSettings: { connectionId: 'gateway', imageInput: 'inline-base64' },
    })).toMatchObject({ kind: 'inline-base64', limits: { maxImages: 4 } })
    expect(imageInputCapabilityForApp({
      vendor: 'openai-compat', model: 'vision', vendorSettings: { connectionId: 'gateway' },
    })).toMatchObject({ kind: 'unsupported' })
  })

  it('keeps the existing Kimi public rollout gate', () => {
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
    expect(imageInputCapabilityForApp({ vendor: 'kimi', model: 'kimi-k3' }))
      .toMatchObject({ kind: 'unsupported', reason: 'Kimi 图片输入尚未开放。' })
  })
})
