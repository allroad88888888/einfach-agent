import { userMessageVersion, type ModelItem } from '@einfach-agent/ai'
import {
  canonicalContextCacheValue,
  contextCacheFingerprintText,
} from './contextCacheFingerprint'

/** Privacy-safe explanation of how this projection differs from the previous lane request. */
export interface ContextProjectionDiagnostics {
  transition: 'initial' | 'identical' | 'fact_appended' | 'dynamic_tail_changed' | 'fact_rewritten'
  previousItems?: number
  currentItems: number
  previousFactItems?: number
  currentFactItems: number
  commonPrefixItems?: number
  factCommonPrefixItems?: number
  firstChangedItemIndex?: number
  previousItemRole?: string
  currentItemRole?: string
  previousItemChars?: number
  currentItemChars?: number
  dynamicControlsChanged?: boolean
  dynamicControlFingerprint: string
}

export interface ContextProjectionItemDiagnostic {
  fingerprint: string
  role: string
  chars: number
}

export interface ContextProjectionPreviousState {
  projectionItems: ContextProjectionItemDiagnostic[]
  dynamicControlFingerprint: string
  dynamicTailCount: number
}

export function describeContextProjection(
  messages: readonly ModelItem[],
): ContextProjectionItemDiagnostic[] {
  return messages.map((message) => {
    const serialized = canonicalContextCacheValue(message.role === 'user'
      ? { ...message, content: userMessageVersion(message.content) }
      : message)
    return {
      fingerprint: contextCacheFingerprintText('message', serialized),
      role: message.role,
      chars: serialized.length,
    }
  })
}

function commonPrefixLength(
  previous: readonly ContextProjectionItemDiagnostic[],
  current: readonly ContextProjectionItemDiagnostic[],
): number {
  const limit = Math.min(previous.length, current.length)
  let index = 0
  while (index < limit && previous[index].fingerprint === current[index].fingerprint) index += 1
  return index
}

export function contextProjectionDiagnostics(
  previous: ContextProjectionPreviousState | undefined,
  current: ContextProjectionItemDiagnostic[],
  dynamicTailCount: number,
  dynamicControlFingerprint: string,
): ContextProjectionDiagnostics {
  const currentFacts = dynamicTailCount > 0 ? current.slice(0, -dynamicTailCount) : current
  if (!previous) {
    return {
      transition: 'initial',
      currentItems: current.length,
      currentFactItems: currentFacts.length,
      dynamicControlFingerprint,
    }
  }

  const previousFacts = previous.dynamicTailCount > 0
    ? previous.projectionItems.slice(0, -previous.dynamicTailCount)
    : previous.projectionItems
  const commonPrefixItems = commonPrefixLength(previous.projectionItems, current)
  const factCommonPrefixItems = commonPrefixLength(previousFacts, currentFacts)
  const previousItem = previous.projectionItems[commonPrefixItems]
  const currentItem = current[commonPrefixItems]
  const dynamicControlsChanged = previous.dynamicControlFingerprint !== dynamicControlFingerprint
  const factsEqual = previousFacts.length === currentFacts.length
    && factCommonPrefixItems === previousFacts.length
  const factsAppendOnly = factCommonPrefixItems === previousFacts.length
    && currentFacts.length > previousFacts.length
  const transition = factsEqual
    ? dynamicControlsChanged ? 'dynamic_tail_changed' : 'identical'
    : factsAppendOnly ? 'fact_appended' : 'fact_rewritten'

  return {
    transition,
    previousItems: previous.projectionItems.length,
    currentItems: current.length,
    previousFactItems: previousFacts.length,
    currentFactItems: currentFacts.length,
    commonPrefixItems,
    factCommonPrefixItems,
    firstChangedItemIndex: previousItem || currentItem ? commonPrefixItems : undefined,
    previousItemRole: previousItem?.role,
    currentItemRole: currentItem?.role,
    previousItemChars: previousItem?.chars,
    currentItemChars: currentItem?.chars,
    dynamicControlsChanged,
    dynamicControlFingerprint,
  }
}

/** Flattens privacy-safe projection diagnostics for trace event and span attributes. */
export function contextProjectionTraceAttrs(profile: {
  projectionDiagnostics: ContextProjectionDiagnostics
}): Record<string, unknown> {
  const diagnostics = profile.projectionDiagnostics
  return {
    cache_projection_transition: diagnostics.transition,
    cache_projection_previous_items: diagnostics.previousItems,
    cache_projection_current_items: diagnostics.currentItems,
    cache_projection_previous_fact_items: diagnostics.previousFactItems,
    cache_projection_current_fact_items: diagnostics.currentFactItems,
    cache_projection_common_prefix_items: diagnostics.commonPrefixItems,
    cache_projection_fact_common_prefix_items: diagnostics.factCommonPrefixItems,
    cache_projection_first_changed_item_index: diagnostics.firstChangedItemIndex,
    cache_projection_previous_item_role: diagnostics.previousItemRole,
    cache_projection_current_item_role: diagnostics.currentItemRole,
    cache_projection_previous_item_chars: diagnostics.previousItemChars,
    cache_projection_current_item_chars: diagnostics.currentItemChars,
    cache_projection_dynamic_controls_changed: diagnostics.dynamicControlsChanged,
    cache_projection_dynamic_controls_fingerprint: diagnostics.dynamicControlFingerprint,
  }
}
