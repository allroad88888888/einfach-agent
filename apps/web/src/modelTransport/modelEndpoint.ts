import { DEEPSEEK_BASE_URL, GLM_BASE_URL } from '@web-agent/ai'

export type ModelProvider = 'deepseek' | 'glm'

const CHAT_COMPLETIONS_PATH = '/chat/completions'

const providerUrls: Readonly<Record<ModelProvider, string>> = {
  deepseek: `${DEEPSEEK_BASE_URL}${CHAT_COMPLETIONS_PATH}`,
  glm: `${GLM_BASE_URL}${CHAT_COMPLETIONS_PATH}`,
}

function urlText(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** Maps only the application's fixed provider endpoints to trusted provider identifiers. */
export function modelProviderForChatRequest(input: RequestInfo | URL): ModelProvider {
  const url = urlText(input)
  const provider = (Object.keys(providerUrls) as ModelProvider[]).find(
    (candidate) => url === providerUrls[candidate],
  )
  if (!provider) throw new Error('模型请求目标未获允许')
  return provider
}
