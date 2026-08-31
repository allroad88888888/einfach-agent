import { describe, expect, it } from 'vitest'
import type { UserImageContentBlock } from './modelProtocol'
import { projectHistoryImage } from './historyImageCompatibility'

function image(scope = 'kimi:cn', reference = 'ms://file-one'): UserImageContentBlock {
  return {
    type: 'image',
    source: { kind: 'provider-file', provider: 'kimi', scope, reference },
    name: 'one.png',
    mimeType: 'image/png',
    byteSize: 10,
  }
}

function deepSeekImage(
  scope = 'deepseek:default',
  reference = 'file-api-one',
): UserImageContentBlock {
  return {
    ...image(scope, reference),
    source: { kind: 'provider-file', provider: 'deepseek', scope, reference },
  }
}

describe('persisted history image compatibility', () => {
  it.each(['glm', 'unknown'])('conservatively rejects %s targets', (vendor) => {
    expect(projectHistoryImage(image(), { vendor, model: 'anything' })).toMatchObject({
      kind: 'placeholder',
      reason: 'target_provider_unsupported',
    })
  })

  it('rejects a Kimi model without an exact verified image contract', () => {
    expect(projectHistoryImage(image(), { vendor: 'kimi', model: 'kimi-k3' })).toMatchObject({
      kind: 'placeholder',
      reason: 'target_model_unsupported',
    })
  })

  it('rejects a provider file from a different Kimi region', () => {
    expect(projectHistoryImage(image('kimi:cn'), {
      vendor: 'kimi', model: 'kimi-k2.6', region: 'global',
    })).toMatchObject({ kind: 'placeholder', reason: 'source_region_mismatch' })
  })

  it('accepts only a valid ms reference in the matching model region', () => {
    expect(projectHistoryImage(image(), {
      vendor: 'kimi', model: 'kimi-k2.6', region: 'cn',
    })).toMatchObject({ kind: 'consumable' })
    expect(projectHistoryImage(image('kimi:cn', 'https://example.com/private'), {
      vendor: 'kimi', model: 'kimi-k2.6', region: 'cn',
    })).toMatchObject({ kind: 'placeholder', reason: 'source_reference_invalid' })
  })

  it('accepts DeepSeek Files references only for the vision model and default scope', () => {
    expect(projectHistoryImage(deepSeekImage(), {
      vendor: 'deepseek', model: 'deepseek-v4-flash-vision-exp',
    })).toMatchObject({ kind: 'consumable' })
    expect(projectHistoryImage(deepSeekImage(), {
      vendor: 'deepseek', model: 'deepseek-v4-flash',
    })).toMatchObject({ kind: 'placeholder', reason: 'target_model_unsupported' })
    expect(projectHistoryImage(image(), {
      vendor: 'deepseek', model: 'deepseek-v4-flash-vision-exp',
    })).toMatchObject({ kind: 'placeholder', reason: 'source_provider_mismatch' })
    expect(projectHistoryImage(deepSeekImage('deepseek:other'), {
      vendor: 'deepseek', model: 'deepseek-v4-flash-vision-exp',
    })).toMatchObject({ kind: 'placeholder', reason: 'source_region_mismatch' })
    expect(projectHistoryImage(deepSeekImage('deepseek:default', 'file-one'), {
      vendor: 'deepseek', model: 'deepseek-v4-flash-vision-exp',
    })).toMatchObject({ kind: 'placeholder', reason: 'source_reference_invalid' })
  })
})
