import {
  PROVIDER_ROUTE_POLICIES,
  type ProviderBodyKind,
  type ProviderMethod,
  type ProviderRoutePathPolicy,
} from '@einfach-agent/ai'
import type { ModelProviderName, ProviderScope } from './provider'
import {
  OPENAI_COMPAT_ORIGIN,
  type ProviderOrigin,
} from './registeredProviderOrigin'

export interface ProviderRouteEntry {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: ProviderRoutePathPolicy
  readonly origin: ProviderOrigin
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

/**
 * Host origin bindings projected from agent-ai's environment-neutral route policy. Official
 * origins pass through unchanged; the OpenAI-compatible origin remains host-registered state.
 */
export const PROVIDER_ROUTES: readonly ProviderRouteEntry[] = PROVIDER_ROUTE_POLICIES.map(
  ({ officialOrigin, ...policy }) => ({
    ...policy,
    origin: officialOrigin ?? OPENAI_COMPAT_ORIGIN,
  }),
)
