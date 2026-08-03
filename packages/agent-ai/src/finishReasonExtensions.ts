// Provider finish_reason extension registry.

import {
  deepSeekFinishReasonExtensionFor,
  deepSeekFinishReasonExtensions,
} from './deepseek'
import type { ModelFinishReasonExtension } from './modelApi'

/** Returns a provider-owned extension for an otherwise generic finish reason. */
export function finishReasonExtensionFor(
  reason: string | null,
): ModelFinishReasonExtension | undefined {
  return deepSeekFinishReasonExtensionFor(reason)
}

/** Lists extensions for legacy consumers that need reason-keyed lookups. */
export function finishReasonExtensions(): readonly ModelFinishReasonExtension[] {
  return deepSeekFinishReasonExtensions()
}
