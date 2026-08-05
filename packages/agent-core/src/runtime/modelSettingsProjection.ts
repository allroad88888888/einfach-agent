import type { ChatRequestBase } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'

/** Returns sampling values only for providers whose session type supports them. */
export function modelSamplingSettings(settings: ModelSettings): {
  temperature: ChatRequestBase['temperature'] | undefined
  maxTokens: ChatRequestBase['max_tokens'] | undefined
} {
  if (settings.vendor === 'kimi') return { temperature: undefined, maxTokens: undefined }
  return { temperature: settings.temperature, maxTokens: settings.max_tokens }
}

/** Kimi K2.6 has a thinking switch but deliberately has no reasoning-effort field. */
export function modelReasoningEffort(settings: ModelSettings): string | undefined {
  return settings.vendor === 'kimi' ? undefined : settings.reasoning_effort
}
