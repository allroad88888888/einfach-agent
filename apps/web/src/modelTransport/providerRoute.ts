import {
  DEEPSEEK_BASE_URL,
  GLM_BASE_URL,
  KIMI_CN_BASE_URL,
  type ProviderMethod,
  type ProviderRequestBody,
  type ProviderTarget,
} from '@einfach-agent/ai'

export const PROVIDER_RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/

export type ProviderRouteSpec = {
  bodyKind: ProviderRequestBody['kind']
  url: string
  maxResponseBytes: number
}

const CHAT_RESPONSE_LIMIT = 32 * 1024 * 1024
const FILE_RESPONSE_LIMIT = 4 * 1024 * 1024
const DELETE_RESPONSE_LIMIT = 1024 * 1024

function invalidTarget(): never {
  throw new Error('模型请求目标未获允许')
}

function safeFileDeletePath(path: string): boolean {
  const prefix = '/files/'
  return path.startsWith(prefix)
    && PROVIDER_RESOURCE_ID_PATTERN.test(path.slice(prefix.length))
}

/** Resolves a generic target through the host's exact method/path security policy. */
export function providerRouteSpec(target: ProviderTarget): ProviderRouteSpec {
  if (target.provider === 'deepseek'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    return {
      bodyKind: 'json',
      url: `${DEEPSEEK_BASE_URL}${target.path}`,
      maxResponseBytes: CHAT_RESPONSE_LIMIT,
    }
  }
  if (target.provider === 'glm'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    return {
      bodyKind: 'json',
      url: `${GLM_BASE_URL}${target.path}`,
      maxResponseBytes: CHAT_RESPONSE_LIMIT,
    }
  }
  if (target.provider === 'kimi' && target.scope === 'cn') {
    if (target.method === 'POST' && target.path === '/chat/completions') {
      return {
        bodyKind: 'json',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: CHAT_RESPONSE_LIMIT,
      }
    }
    if (target.method === 'POST' && target.path === '/files') {
      return {
        bodyKind: 'multipart',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: FILE_RESPONSE_LIMIT,
      }
    }
    if (target.method === 'DELETE' && safeFileDeletePath(target.path)) {
      return {
        bodyKind: 'none',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: DELETE_RESPONSE_LIMIT,
      }
    }
  }
  return invalidTarget()
}

function urlText(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** Converts only exact application endpoints into provider-owned method/path targets. */
export function providerTargetForRequest(
  input: RequestInfo | URL,
  method: ProviderMethod = 'POST',
): ProviderTarget {
  const url = urlText(input)
  const candidates: ProviderTarget[] = [
    { provider: 'deepseek', scope: 'default', method, path: url.slice(DEEPSEEK_BASE_URL.length) },
    { provider: 'glm', scope: 'default', method, path: url.slice(GLM_BASE_URL.length) },
    { provider: 'kimi', scope: 'cn', method, path: url.slice(KIMI_CN_BASE_URL.length) },
  ]
  const origins = [DEEPSEEK_BASE_URL, GLM_BASE_URL, KIMI_CN_BASE_URL]
  const candidate = candidates.find((_target, index) => url.startsWith(origins[index]!))
  if (!candidate) return invalidTarget()
  providerRouteSpec(candidate)
  return candidate
}
