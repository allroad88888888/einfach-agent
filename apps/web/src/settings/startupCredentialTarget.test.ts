import { describe, expect, it } from 'vitest'
import type { ModelSettings } from '@web-agent/core'
import { resolveStartupCredentialTarget } from './startupCredentialTarget'

describe('resolveStartupCredentialTarget', () => {
  it.each([
    [undefined, 'deepseek-default'],
    [{ vendor: 'deepseek', model: 'deepseek-chat' }, 'deepseek-default'],
    [{ vendor: 'glm', model: 'glm-5.2' }, 'glm-default'],
    [{ vendor: 'kimi', model: 'kimi-k2.6' }, 'kimi-cn'],
    [{ vendor: 'kimi', model: 'kimi-k2.6', vendorSettings: { region: 'cn' } }, 'kimi-cn'],
  ] as const)('resolves %o to %s', (settings, id) => {
    expect(resolveStartupCredentialTarget(settings as ModelSettings | undefined)).toEqual({
      ok: true,
      id,
    })
  })

  it('keeps unsupported Kimi regions in a controlled failure state', () => {
    const settings = { vendor: 'kimi', model: 'kimi-k2.6', vendorSettings: { region: 'global' } } as ModelSettings

    expect(resolveStartupCredentialTarget(settings)).toEqual({
      ok: false,
      error: 'unsupported-kimi-region',
    })
  })

  it('keeps invalid persisted vendors in a controlled failure state', () => {
    const settings = { vendor: 'other', model: 'unknown' } as unknown as ModelSettings

    expect(resolveStartupCredentialTarget(settings)).toEqual({
      ok: false,
      error: 'unsupported-model-vendor',
    })
  })
})
