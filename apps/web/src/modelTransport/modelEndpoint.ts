import type { ProviderTarget } from '@einfach-agent/ai'
import { providerTargetForRequest } from './providerRoute'

export type ModelProvider = ProviderTarget['provider']

/** Maps only the application's fixed provider endpoints to trusted provider identifiers. */
export function modelProviderForChatRequest(input: RequestInfo | URL): ModelProvider {
  const target = providerTargetForRequest(input)
  if (target.method !== 'POST' || target.path !== '/chat/completions') {
    throw new Error('模型请求目标未获允许')
  }
  return target.provider
}
