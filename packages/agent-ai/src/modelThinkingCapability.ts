// Model-level Thinking contract and provider-neutral validation helpers.

export type ModelThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

interface DocumentedThinkingCapability {
  readonly sourceUrl: string
  readonly defaultEnabled?: boolean
}

interface SupportedThinkingCapability {
  /** Thinking is always on for this model and cannot be disabled. */
  readonly required?: boolean
}

export interface UnsupportedThinkingCapability extends DocumentedThinkingCapability {
  readonly kind: 'unsupported'
}

export interface ToggleThinkingCapability
  extends DocumentedThinkingCapability, SupportedThinkingCapability {
  readonly kind: 'toggle'
}

export interface EffortThinkingCapability
  extends DocumentedThinkingCapability, SupportedThinkingCapability {
  readonly kind: 'effort'
  /** Positive UI/wire values in their stable display order. `auto` is never a wire value. */
  readonly efforts: readonly ModelThinkingEffort[]
  readonly defaultEffort?: ModelThinkingEffort
  /** Documents upstream-equivalent levels without changing the value sent on the wire. */
  readonly effortMappings?: Readonly<Partial<Record<ModelThinkingEffort, ModelThinkingEffort>>>
  /** Upstream spellings that mean Thinking off, kept out of the positive effort list. */
  readonly disabledAliases?: readonly string[]
}

export interface UnknownThinkingCapability {
  readonly kind: 'unknown'
}

export type ModelThinkingCapability =
  | UnsupportedThinkingCapability
  | ToggleThinkingCapability
  | EffortThinkingCapability
  | UnknownThinkingCapability

export const UNKNOWN_THINKING_CAPABILITY: UnknownThinkingCapability = Object.freeze({
  kind: 'unknown',
})

const NO_EFFORTS: readonly ModelThinkingEffort[] = Object.freeze([])

export interface ModelThinkingCapabilityRegistry {
  describeModel(
    vendorId: string,
    modelId: string,
  ): { readonly thinking?: ModelThinkingCapability } | undefined
}

/** Exact model lookup: an unknown vendor or model never inherits an adapter fallback. */
export function getModelThinkingCapability(
  registry: ModelThinkingCapabilityRegistry,
  vendorId: string,
  modelId: string,
): ModelThinkingCapability {
  return registry.describeModel(vendorId, modelId)?.thinking ?? UNKNOWN_THINKING_CAPABILITY
}

export function modelSupportsThinking(
  capability: ModelThinkingCapability,
): capability is ToggleThinkingCapability | EffortThinkingCapability {
  return capability.kind === 'toggle' || capability.kind === 'effort'
}

export function modelRequiresThinking(capability: ModelThinkingCapability): boolean {
  return modelSupportsThinking(capability) && capability.required === true
}

export function thinkingEfforts(
  capability: ModelThinkingCapability,
): readonly ModelThinkingEffort[] {
  return capability.kind === 'effort' ? capability.efforts : NO_EFFORTS
}

export function isSupportedThinkingEffort(
  capability: ModelThinkingCapability,
  value: unknown,
): value is ModelThinkingEffort {
  return typeof value === 'string'
    && capability.kind === 'effort'
    && capability.efforts.some((effort) => effort === value)
}

export function isDisabledThinkingAlias(
  capability: ModelThinkingCapability,
  value: unknown,
): value is string {
  return typeof value === 'string'
    && capability.kind === 'effort'
    && (capability.disabledAliases?.some((alias) => alias === value) ?? false)
}
