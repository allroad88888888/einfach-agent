import { readRegisteredOpenAiCompatOrigin } from './openAiCompatEndpoint'
import type { ProviderTarget } from './providerRoute'
import type { RegisteredProviderOrigins } from './registeredProviderOrigin'
import type { NodeHostInvokeOptions } from '../hostOptions'

/** Legacy no-ID requests retain the single registered endpoint; profiles use an atomic binding. */
export async function legacyRegisteredOriginsForTarget(
  options: NodeHostInvokeOptions,
  target: ProviderTarget,
): Promise<RegisteredProviderOrigins> {
  if (target.provider !== 'openai-compat' || target.connectionId !== undefined) return {}
  return { openAiCompat: await readRegisteredOpenAiCompatOrigin(options) }
}
