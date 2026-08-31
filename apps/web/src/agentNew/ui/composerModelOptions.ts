import {
  defaultProviderRegistry,
  type RegisteredModelDescriptor,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import type { ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'

export type ComposerModelOptionGroup = 'builtin' | 'profile' | 'current'

/** Only the settings fields that identify a selectable model. */
export interface ComposerModelIdentity {
  readonly vendor: string
  readonly model: string
  readonly vendorSettings?: Readonly<{ readonly connectionId: string }>
}

/** A native-select option with a key that must be looked up rather than decoded. */
export interface ComposerModelOption {
  readonly key: string
  readonly label: string
  readonly group: ComposerModelOptionGroup
  readonly groupLabel: string
  readonly identity: ComposerModelIdentity
}

type CurrentModel = Pick<ModelSettings, 'vendor' | 'model' | 'vendorSettings'>

function optionKey(parts: readonly (string | null)[]): string {
  return JSON.stringify(parts)
}

function connectionId(current: CurrentModel): string | undefined {
  const value = current.vendorSettings?.connectionId
  return typeof value === 'string' ? value : undefined
}

function builtinOption(model: RegisteredModelDescriptor): ComposerModelOption {
  return {
    key: optionKey(['builtin', model.vendor, model.model]),
    label: model.displayName,
    group: 'builtin',
    groupLabel: 'Built-in models',
    identity: { vendor: model.vendor, model: model.model },
  }
}

function profileOptions(profile: ModelConnectionProfile): readonly ComposerModelOption[] {
  if (!profile.credentialConfigured) return []
  return profile.models.map((model) => ({
    key: optionKey(['profile', profile.id, model.id]),
    label: model.label,
    group: 'profile' as const,
    groupLabel: profile.label,
    identity: {
      vendor: 'openai-compat',
      model: model.id,
      vendorSettings: { connectionId: profile.id },
    },
  }))
}

function matchesCurrent(option: ComposerModelOption, current: CurrentModel): boolean {
  if (option.identity.vendor !== current.vendor || option.identity.model !== current.model) return false
  return option.identity.vendorSettings?.connectionId === connectionId(current)
}

function currentOption(current: CurrentModel): ComposerModelOption | undefined {
  if (!current.model) return undefined
  const currentConnectionId = connectionId(current)
  return {
    key: optionKey(['current', current.vendor, current.model, currentConnectionId ?? null]),
    label: current.model,
    group: 'current',
    groupLabel: 'Current model',
    identity: currentConnectionId === undefined
      ? { vendor: current.vendor, model: current.model }
      : {
        vendor: current.vendor,
        model: current.model,
        vendorSettings: { connectionId: currentConnectionId },
      },
  }
}

/** Projects reviewed built-ins and available connection profiles into select options. */
export function composerModelOptions(
  current: CurrentModel | undefined,
  profiles: readonly ModelConnectionProfile[],
): readonly ComposerModelOption[] {
  const options = [
    ...defaultProviderRegistry.listModels().map(builtinOption),
    ...profiles.flatMap(profileOptions),
  ]
  const missingCurrent = current === undefined || options.some((option) => matchesCurrent(option, current))
    ? undefined
    : currentOption(current)
  return missingCurrent === undefined ? options : [missingCurrent, ...options]
}

/** Resolves a select value without inferring identity from its human-facing label. */
export function findComposerModelOption(
  options: readonly ComposerModelOption[],
  key: string,
): ComposerModelOption | undefined {
  return options.find((option) => option.key === key)
}
