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

describe('persisted history image compatibility', () => {
  it.each(['deepseek', 'glm', 'unknown'])('conservatively rejects %s targets', (vendor) => {
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
})
