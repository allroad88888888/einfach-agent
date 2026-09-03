import {
  DEEPSEEK_BASE_URL,
  GLM_BASE_URL,
  KIMI_CN_BASE_URL,
} from './providerOrigins'

export const PROVIDER_TRANSPORT_LIMITS = Object.freeze({
  maxJsonBytes: 4 * 1024 * 1024,
  maxMultipartParts: 16,
  maxMultipartFiles: 8,
  maxMultipartFileBytes: 20 * 1024 * 1024,
  maxMultipartBatchBytes: 40 * 1024 * 1024,
  maxMultipartTextBytes: 64 * 1024,
  maxMultipartTextBatchBytes: 256 * 1024,
  maxPartNameBytes: 64,
  maxFileNameBytes: 255,
  maxContentTypeBytes: 128,
  maxRequestIdBytes: 128,
  maxWireRequestBytes: 56 * 1024 * 1024,
  maxChatResponseBytes: 32 * 1024 * 1024,
  maxFileResponseBytes: 4 * 1024 * 1024,
  maxDeleteResponseBytes: 1024 * 1024,
  requestTimeoutMs: 120_000,
})

export type ProviderScope = 'default' | 'cn'

export type ProviderMethod = 'POST' | 'DELETE'

export type ProviderBodyKind = ProviderRequestBody['kind']

const textEncoder = new TextEncoder()

const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const PROVIDER_PART_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const PROVIDER_CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const PROVIDER_FILE_NAME_FORBIDDEN_PATTERN = /[\u0000-\u001f\u007f-\u009f/\\]/u
const PROVIDER_RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/
const DEEPSEEK_FILE_ID_PATTERN = /^file-api-[A-Za-z0-9][A-Za-z0-9_-]{0,246}$/

export function providerUtf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

export function isValidProviderRequestId(requestId: string): boolean {
  return PROVIDER_REQUEST_ID_PATTERN.test(requestId)
    && requestId.length <= PROVIDER_TRANSPORT_LIMITS.maxRequestIdBytes
}

export function isValidProviderPartName(name: string): boolean {
  return PROVIDER_PART_NAME_PATTERN.test(name)
    && providerUtf8ByteLength(name) <= PROVIDER_TRANSPORT_LIMITS.maxPartNameBytes
}

export function isValidProviderFileName(fileName: string): boolean {
  return fileName.length > 0
    && providerUtf8ByteLength(fileName) <= PROVIDER_TRANSPORT_LIMITS.maxFileNameBytes
    && !PROVIDER_FILE_NAME_FORBIDDEN_PATTERN.test(fileName)
}

export function isValidProviderContentType(contentType: string): boolean {
  return PROVIDER_CONTENT_TYPE_PATTERN.test(contentType)
    && providerUtf8ByteLength(contentType) <= PROVIDER_TRANSPORT_LIMITS.maxContentTypeBytes
}

export function isValidProviderResourceId(resourceId: string): boolean {
  return PROVIDER_RESOURCE_ID_PATTERN.test(resourceId)
}

/** DeepSeek's file ID contract, shared by upload responses, message references, and deletion. */
export function isValidDeepSeekFileId(fileId: string): boolean {
  return DEEPSEEK_FILE_ID_PATTERN.test(fileId)
}

// openai-compat 与前三家的差别只在**宿主怎么查出 origin**，不在这张身份表上：调用方能表达的
// 依旧只有身份/方法/路径与可选 profile ID，origin 一个字节都不来自这里。它的 origin 由宿主从
// 自己的配置文件里读那一条**用户显式登记**的 base URL（host-node 的 openAiCompatEndpoint.ts），
// 因此这里加一个身份并不扩大调用方的能力面——没登记过就是「目标未获允许」。
type ProviderIdentity =
  | { provider: 'deepseek'; scope: 'default' }
  | { provider: 'glm'; scope: 'default' }
  | { provider: 'kimi'; scope: 'cn' }
  | { provider: 'openai-compat'; scope: 'default' }

/** Provider-owned method/path carried through a host-controlled provider origin. */
export type ProviderTarget =
  | (Exclude<ProviderIdentity, { provider: 'openai-compat' }> & {
      method: ProviderMethod
      path: string
      connectionId?: never
    })
  | ({ provider: 'openai-compat'; scope: 'default' } & {
      method: ProviderMethod
      path: string
      /** Host-owned profile selector. URLs, keys, and provider headers never belong here. */
      connectionId?: string
    })

export type ProviderMultipartPart =
  | { kind: 'text'; name: string; value: string }
  | {
      kind: 'file'
      name: string
      fileName: string
      contentType: string
      data: Blob
    }

export type ProviderRequestBody =
  | { kind: 'none' }
  | { kind: 'json'; json: string }
  | { kind: 'multipart'; parts: readonly ProviderMultipartPart[] }

export const PROVIDER_OFFICIAL_ORIGINS = Object.freeze({
  deepseek: { provider: 'deepseek', scope: 'default', origin: DEEPSEEK_BASE_URL },
  glm: {
    provider: 'glm', scope: 'default', origin: GLM_BASE_URL,
  },
  kimi: { provider: 'kimi', scope: 'cn', origin: KIMI_CN_BASE_URL },
} as const)

export type ProviderRoutePathPolicy =
  | { readonly kind: 'exact'; readonly value: string }
  | {
      readonly kind: 'file-resource'
      readonly idKind: 'provider-resource' | 'deepseek-file'
    }

export interface ProviderRoutePolicy {
  readonly provider: ProviderTarget['provider']
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: ProviderRoutePathPolicy
  /** Absent only for the host-registered OpenAI-compatible origin. */
  readonly officialOrigin?: string
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

const exactPath = (value: string): ProviderRoutePathPolicy => ({ kind: 'exact', value })
const fileResourcePath = (idKind: 'provider-resource' | 'deepseek-file'):
ProviderRoutePathPolicy => ({ kind: 'file-resource', idKind })

const CHAT_RESPONSE_LIMIT = PROVIDER_TRANSPORT_LIMITS.maxChatResponseBytes
const FILE_RESPONSE_LIMIT = PROVIDER_TRANSPORT_LIMITS.maxFileResponseBytes
const DELETE_RESPONSE_LIMIT = PROVIDER_TRANSPORT_LIMITS.maxDeleteResponseBytes

/** Complete environment-neutral provider method/path/body/response policy. */
export const PROVIDER_ROUTE_POLICIES: readonly ProviderRoutePolicy[] = Object.freeze([
  {
    provider: 'deepseek', scope: 'default', method: 'POST',
    path: exactPath('/chat/completions'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.deepseek.origin,
    bodyKind: 'json', maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'deepseek', scope: 'default', method: 'POST', path: exactPath('/files'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.deepseek.origin,
    bodyKind: 'multipart', maxResponseBytes: FILE_RESPONSE_LIMIT,
  },
  {
    provider: 'deepseek', scope: 'default', method: 'DELETE',
    path: fileResourcePath('deepseek-file'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.deepseek.origin,
    bodyKind: 'none', maxResponseBytes: DELETE_RESPONSE_LIMIT,
  },
  {
    provider: 'glm', scope: 'default', method: 'POST', path: exactPath('/chat/completions'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.glm.origin,
    bodyKind: 'json', maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi', scope: 'cn', method: 'POST', path: exactPath('/chat/completions'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.kimi.origin,
    bodyKind: 'json', maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi', scope: 'cn', method: 'POST', path: exactPath('/files'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.kimi.origin,
    bodyKind: 'multipart', maxResponseBytes: FILE_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi', scope: 'cn', method: 'DELETE',
    path: fileResourcePath('provider-resource'),
    officialOrigin: PROVIDER_OFFICIAL_ORIGINS.kimi.origin,
    bodyKind: 'none', maxResponseBytes: DELETE_RESPONSE_LIMIT,
  },
  {
    provider: 'openai-compat', scope: 'default', method: 'POST',
    path: exactPath('/chat/completions'),
    bodyKind: 'json', maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
])

function routePathMatches(policy: ProviderRoutePathPolicy, path: string): boolean {
  if (policy.kind === 'exact') return path === policy.value
  if (!path.startsWith('/files/')) return false
  const id = path.slice('/files/'.length)
  return policy.idKind === 'deepseek-file'
    ? isValidDeepSeekFileId(id)
    : isValidProviderResourceId(id)
}

export function providerRoutePolicyMatches(
  policy: ProviderRoutePolicy,
  target: Pick<ProviderTarget, 'provider' | 'scope' | 'method' | 'path'>,
): boolean {
  return policy.provider === target.provider
    && policy.scope === target.scope
    && policy.method === target.method
    && routePathMatches(policy.path, target.path)
}

export function findProviderRoutePolicy(
  target: Pick<ProviderTarget, 'provider' | 'scope' | 'method' | 'path'>,
): ProviderRoutePolicy | undefined {
  return PROVIDER_ROUTE_POLICIES.find((policy) => providerRoutePolicyMatches(policy, target))
}

export type ProviderWireMultipartPart =
  | { kind: 'text'; name: string; value: string }
  | {
      kind: 'file'
      name: string
      fileName: string
      contentType: string
      bytesBase64: string
    }

export type ProviderWireRequestBody =
  | { kind: 'none' }
  | { kind: 'json'; json: string }
  | { kind: 'multipart'; parts: readonly ProviderWireMultipartPart[] }

export interface ProviderTransportInput {
  target: ProviderTarget
  body: ProviderRequestBody
  signal?: AbortSignal
}

export interface ProviderWireRequest {
  target: ProviderTarget
  body: ProviderWireRequestBody
  requestId: string
}

export interface ProviderTransport {
  request(input: ProviderTransportInput): Promise<Response>
}
