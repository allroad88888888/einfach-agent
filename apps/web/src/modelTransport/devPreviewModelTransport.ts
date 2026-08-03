import { modelProviderForChatRequest } from './modelEndpoint'

const MODEL_PREVIEW_RELAY_PATH = '/__web_agent_model_preview'

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== 'string') throw new Error('模型请求格式无效')
  return init.body
}

function requirePostMethod(init?: RequestInit): void {
  if (!init?.method || init.method.toUpperCase() === 'POST') return
  throw new Error('模型开发请求只允许 POST 方法')
}

/** Routes browser development requests to the local Node relay without forwarding browser credentials. */
export function createDevPreviewModelFetch(): typeof fetch {
  return async (input, init) => {
    const provider = modelProviderForChatRequest(input)
    requirePostMethod(init)
    return fetch(`${MODEL_PREVIEW_RELAY_PATH}/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(init),
      signal: init?.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
  }
}
