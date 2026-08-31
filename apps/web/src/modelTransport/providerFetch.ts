import {
  createProviderTransportFetch,
  type ProviderLocalRequestIdentity,
  type ProviderMultipartPart,
  type ProviderMethod,
  type ProviderRequestBody,
  type ProviderTarget,
  type ProviderTransport,
  type ProviderTransportInput,
} from '@einfach-agent/ai'
import { providerRouteSpec, providerTargetForRequest } from './providerRoute'

function requestMethod(input: RequestInfo | URL, init?: RequestInit): ProviderMethod {
  const method = init?.method
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'POST')
  const normalized = method.toUpperCase()
  if (normalized === 'POST' || normalized === 'DELETE') return normalized
  throw new Error('模型请求目标未获允许')
}

function multipartParts(form: FormData): ProviderMultipartPart[] {
  const parts: ProviderMultipartPart[] = []
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push({ kind: 'text', name, value })
      continue
    }
    parts.push({
      kind: 'file',
      name,
      fileName: value.name || 'blob',
      contentType: value.type || 'application/octet-stream',
      data: value,
    })
  }
  return parts
}

function requestBody(target: ProviderTarget, init?: RequestInit): ProviderRequestBody {
  const expected = providerRouteSpec(target).bodyKind
  if (expected === 'none') {
    if (init?.body != null) throw new Error('模型请求格式无效')
    return { kind: 'none' }
  }
  if (expected === 'json') {
    if (typeof init?.body !== 'string') throw new Error('模型请求格式无效')
    return { kind: 'json', json: init.body }
  }
  if (!(init?.body instanceof FormData)) throw new Error('模型请求格式无效')
  return { kind: 'multipart', parts: multipartParts(init.body) }
}

function providerInputForClosedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  identity?: ProviderLocalRequestIdentity,
): ProviderTransportInput {
  const target = providerTargetForRequest(
    input,
    requestMethod(input, init),
    identity?.connectionId,
    identity?.legacyOpenAiCompat === true,
  )
  return {
    target,
    body: requestBody(target, init),
    signal: init?.signal ?? undefined,
  }
}

export function providerInputForFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): ProviderTransportInput {
  return providerInputForClosedFetch(input, init)
}

/** Keeps the existing fetch injection surface while delegating to the closed provider transport. */
export function createProviderFetch(transport: ProviderTransport): typeof fetch {
  return createProviderTransportFetch((input, init, identity) => {
    return transport.request(providerInputForClosedFetch(input, init, identity))
  })
}
