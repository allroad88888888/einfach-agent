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

type ProviderIdentity =
  | { provider: 'deepseek'; scope: 'default' }
  | { provider: 'glm'; scope: 'default' }
  | { provider: 'kimi'; scope: 'cn' }

/** Provider-owned method/path carried through a host-controlled provider origin. */
export type ProviderTarget = ProviderIdentity & {
  method: ProviderMethod
  path: string
}

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
