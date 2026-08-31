import { normalizeOpenAiCompatBaseUrl } from './openAiCompatBaseUrl'

/** Host-resolved dynamic origins. Callers can never put these values in a wire target. */
export interface RegisteredProviderOrigins {
  readonly openAiCompat?: string
}

export interface RegisteredOrigin {
  readonly registered: keyof RegisteredProviderOrigins
  readonly normalize: (value: string) => string | undefined
}

export type ProviderOrigin = string | RegisteredOrigin

/** The legacy no-ID OpenAI-compatible route keeps its existing registered endpoint policy. */
export const OPENAI_COMPAT_ORIGIN: RegisteredOrigin = {
  registered: 'openAiCompat',
  normalize: normalizeOpenAiCompatBaseUrl,
}

export function resolveProviderOrigin(
  origin: ProviderOrigin,
  registeredOrigins: RegisteredProviderOrigins,
): string | undefined {
  if (typeof origin === 'string') return origin
  const value = registeredOrigins[origin.registered]
  return value === undefined ? undefined : origin.normalize(value)
}
