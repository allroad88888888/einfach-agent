import {
  PROVIDER_TRANSPORT_LIMITS as LIMITS,
  isValidProviderRequestId,
  type ProviderTransportInput,
  type ProviderWireRequest,
} from '@einfach-agent/ai'
import { encodeProviderWireBody } from './providerWireBody'

const textEncoder = new TextEncoder()
let fallbackRequestSequence = 0

function invalidEnvelope(): never {
  throw new Error('模型请求格式无效')
}

export function createProviderRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid && isValidProviderRequestId(uuid)) return uuid
  fallbackRequestSequence += 1
  return `model-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function validateProviderWireRequestSize(
  request: ProviderWireRequest,
  maxBytes = LIMITS.maxWireRequestBytes,
): void {
  if (!isValidProviderRequestId(request.requestId)
    || textEncoder.encode(JSON.stringify(request)).byteLength > maxBytes) invalidEnvelope()
}

/** Encodes the complete canonical envelope before either desktop or relay transport. */
export async function encodeProviderWireRequest(
  input: ProviderTransportInput,
  requestId = createProviderRequestId(),
): Promise<ProviderWireRequest> {
  input.signal?.throwIfAborted()
  const request: ProviderWireRequest = {
    target: input.target,
    body: await encodeProviderWireBody(input),
    requestId,
  }
  validateProviderWireRequestSize(request)
  return request
}
