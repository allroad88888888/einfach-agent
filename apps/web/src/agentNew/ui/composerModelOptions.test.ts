import { defaultProviderRegistry } from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import { describe, expect, it } from 'vitest'
import type { ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'
import { composerModelOptions, findComposerModelOption } from './composerModelOptions'

function profile(
  id: string,
  label: string,
  models: readonly { id: string; label: string }[],
  credentialConfigured = true,
): ModelConnectionProfile {
  return {
    id,
    label,
    kind: 'openai-compatible',
    baseUrl: `https://${id}.example.test/v1`,
    credentialConfigured,
    models: models.map((model) => ({ ...model, source: 'manual' as const })),
  }
}

function optionKeys(options: ReturnType<typeof composerModelOptions>): readonly string[] {
  return options.map((option) => option.key)
}

describe('composerModelOptions', () => {
  it('includes every built-in registry model with its audited display name', () => {
    const options = composerModelOptions(undefined, [])

    expect(options).toEqual(defaultProviderRegistry.listModels().map((model) => expect.objectContaining({
      group: 'builtin',
      groupLabel: 'Built-in models',
      label: model.displayName,
      identity: { vendor: model.vendor, model: model.model },
    })))
  })

  it('groups each available profile model by its public label without exposing endpoint metadata', () => {
    const options = composerModelOptions(undefined, [profile('gateway-a', 'Gateway A', [
      { id: 'chat', label: 'Chat' }, { id: 'reasoning', label: 'Reasoning' },
    ])])
    const profiles = options.filter((option) => option.group === 'profile')

    expect(profiles).toEqual([
      expect.objectContaining({ groupLabel: 'Gateway A', label: 'Chat', identity: {
        vendor: 'openai-compat', model: 'chat', vendorSettings: { connectionId: 'gateway-a' },
      } }),
      expect.objectContaining({ groupLabel: 'Gateway A', label: 'Reasoning', identity: {
        vendor: 'openai-compat', model: 'reasoning', vendorSettings: { connectionId: 'gateway-a' },
      } }),
    ])
    expect(JSON.stringify(options)).not.toContain('https://gateway-a.example.test/v1')
    expect(JSON.stringify(options)).not.toContain('credentialConfigured')
  })

  it('keeps identically named profile models separate with special-character-safe keys', () => {
    const model = 'model:shared/雪'
    const options = composerModelOptions(undefined, [
      profile('gateway:one/雪', 'One', [{ id: model, label: 'Shared' }]),
      profile('gateway:two/雪', 'Two', [{ id: model, label: 'Shared' }]),
    ])
    const matching = options.filter((option) => option.identity.model === model)

    expect(matching).toHaveLength(2)
    expect(new Set(optionKeys(matching))).toHaveLength(2)
    expect(findComposerModelOption(options, matching[0].key)?.identity).not.toEqual(
      findComposerModelOption(options, matching[1].key)?.identity,
    )
    expect(findComposerModelOption(options, 'profile:gateway:one/雪:model:shared/雪')).toBeUndefined()
  })

  it('retains an unavailable current model rather than silently selecting a built-in one', () => {
    const current: ModelSettings = {
      vendor: 'openai-compat', model: 'deleted:model/雪', vendorSettings: { connectionId: 'gone:id' },
    }
    const options = composerModelOptions(current, [
      profile('unavailable', 'Unavailable', [{ id: 'not-listed', label: 'Not listed' }], false),
    ])

    expect(options[0]).toMatchObject({
      group: 'current', groupLabel: 'Current model', label: 'deleted:model/雪',
      identity: { vendor: 'openai-compat', model: 'deleted:model/雪', vendorSettings: { connectionId: 'gone:id' } },
    })
    expect(options.some((option) => option.groupLabel === 'Unavailable')).toBe(false)
  })

  it('keeps registry and profile ordering and keys stable across projections', () => {
    const current: ModelSettings = { vendor: 'deepseek', model: 'deepseek-v4-flash' }
    const profiles = [
      profile('second', 'Second', [{ id: 'two', label: 'Two' }]),
      profile('first', 'First', [{ id: 'one', label: 'One' }]),
    ]

    const first = composerModelOptions(current, profiles)
    const second = composerModelOptions(current, profiles)
    expect(optionKeys(second)).toEqual(optionKeys(first))
    expect(first.filter((option) => option.group === 'profile').map((option) => option.groupLabel)).toEqual([
      'Second', 'First',
    ])
  })
})
