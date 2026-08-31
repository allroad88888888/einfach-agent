import {
  isSupportedThinkingEffort,
  modelSupportsThinking,
  type ModelThinkingCapability,
  type ModelThinkingEffort,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'

export type ComposerModelIdentity = Pick<ModelSettings, 'vendor' | 'model' | 'vendorSettings'>
export type ComposerThinkingEffort = ModelThinkingEffort | 'auto'

const REASONING_EFFORT = 'reasoning_effort'
const CONNECTION_ID = 'connectionId'

function withoutEmptyVendorSettings(
  vendorSettings: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (vendorSettings === undefined) return undefined
  const copy: Record<string, unknown> = { ...vendorSettings }
  return Object.keys(copy).length === 0 ? undefined : copy
}

function normalizeEffort(
  vendorSettings: Readonly<Record<string, unknown>> | undefined,
  capability: ModelThinkingCapability,
): Readonly<Record<string, unknown>> | undefined {
  const copy: Record<string, unknown> = { ...vendorSettings }
  const effort = copy[REASONING_EFFORT]
  if (!isSupportedThinkingEffort(capability, effort)) delete copy[REASONING_EFFORT]
  return withoutEmptyVendorSettings(copy)
}

function writeSettings(
  current: ModelSettings,
  identity: Pick<ModelSettings, 'vendor' | 'model'>,
  thinking: boolean | undefined,
  vendorSettings: Readonly<Record<string, unknown>> | undefined,
): ModelSettings {
  const {
    vendor: _vendor,
    model: _model,
    thinking: _thinking,
    vendorSettings: _vendorSettings,
    ...sharedSettings
  } = current
  return {
    ...sharedSettings,
    vendor: identity.vendor,
    model: identity.model,
    ...(thinking === undefined ? {} : { thinking }),
    ...(vendorSettings === undefined ? {} : { vendorSettings }),
  }
}

function normalizeThinkingSettings(
  current: ModelSettings,
  identity: Pick<ModelSettings, 'vendor' | 'model'>,
  capability: ModelThinkingCapability,
  vendorSettings: Readonly<Record<string, unknown>> | undefined,
): ModelSettings {
  if (!modelSupportsThinking(capability)) {
    return writeSettings(current, identity, undefined, normalizeEffort(vendorSettings, capability))
  }
  return writeSettings(current, identity, current.thinking, normalizeEffort(vendorSettings, capability))
}

function targetVendorSettings(
  current: ModelSettings,
  target: ComposerModelIdentity,
): Readonly<Record<string, unknown>> | undefined {
  if (target.vendor !== current.vendor) return withoutEmptyVendorSettings(target.vendorSettings)

  const currentSettings: Record<string, unknown> = { ...current.vendorSettings }
  const targetSettings: Record<string, unknown> = { ...target.vendorSettings }
  delete currentSettings[CONNECTION_ID]
  const targetConnectionId = targetSettings[CONNECTION_ID]
  delete targetSettings[CONNECTION_ID]
  return withoutEmptyVendorSettings({
    ...currentSettings,
    ...targetSettings,
    ...(targetConnectionId === undefined ? {} : { [CONNECTION_ID]: targetConnectionId }),
  })
}

/** Selects a model while keeping only vendor settings that belong to its identity. */
export function selectComposerModelSettings(
  current: ModelSettings,
  target: ComposerModelIdentity,
  capability: ModelThinkingCapability,
): ModelSettings {
  return normalizeThinkingSettings(current, target, capability, targetVendorSettings(current, target))
}

/** Changes the Thinking toggle without discarding a still-valid selected effort. */
export function setComposerThinkingEnabled(
  current: ModelSettings,
  capability: ModelThinkingCapability,
  enabled: boolean,
): ModelSettings {
  if (!modelSupportsThinking(capability)) {
    return normalizeThinkingSettings(current, current, capability, current.vendorSettings)
  }
  const vendorSettings = normalizeEffort(current.vendorSettings, capability)
  return writeSettings(current, current, enabled, vendorSettings)
}

/** Selects a legal effort, where Auto is represented by an absent vendor setting. */
export function setComposerThinkingEffort(
  current: ModelSettings,
  capability: ModelThinkingCapability,
  effort: ComposerThinkingEffort,
): ModelSettings {
  if (!modelSupportsThinking(capability)) {
    return normalizeThinkingSettings(current, current, capability, current.vendorSettings)
  }
  const vendorSettings = normalizeEffort(current.vendorSettings, capability)
  const withoutCurrentEffort = withoutEffort(vendorSettings)
  const nextVendorSettings = effort === 'auto'
    ? withoutCurrentEffort
    : isSupportedThinkingEffort(capability, effort)
      ? { ...withoutCurrentEffort, [REASONING_EFFORT]: effort }
      : withoutCurrentEffort
  const thinking = current.thinking === undefined
    && capability.kind === 'effort'
    && capability.defaultEnabled === true
    && isSupportedThinkingEffort(capability, effort)
    ? true
    : current.thinking
  return writeSettings(current, current, thinking, withoutEmptyVendorSettings(nextVendorSettings))
}

function withoutEffort(
  vendorSettings: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const copy = { ...vendorSettings }
  delete copy[REASONING_EFFORT]
  return copy
}
