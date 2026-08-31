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
  requestTimeoutMs: 120_000,
})

export type ProviderScope = 'default' | 'cn'

export type ProviderMethod = 'POST' | 'DELETE'

const PROVIDER_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function isValidProviderRequestId(requestId: string): boolean {
  return PROVIDER_REQUEST_ID_PATTERN.test(requestId)
    && requestId.length <= PROVIDER_TRANSPORT_LIMITS.maxRequestIdBytes
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
