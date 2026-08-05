import {
  PROVIDER_TRANSPORT_LIMITS as LIMITS,
  isValidProviderRequestId,
  type ProviderWireMultipartPart,
} from '../packages/agent-ai/src/providerTransport'
import { RelayRequestError } from './model-preview-relay-error'
import {
  resolveModelPreviewRoute,
  type ModelPreviewRoute,
} from './model-preview-relay-routes'

const PART_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type RelayUpstreamRequest = {
  route: ModelPreviewRoute
  body?: string | FormData
  contentType?: string
}

function invalidBody(): never {
  throw new RelayRequestError(400, '模型开发中继请求格式无效。')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidBody()
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!hasExactKeys(value, keys)) invalidBody()
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function validatePartName(name: unknown): asserts name is string {
  if (typeof name !== 'string'
    || !PART_NAME_PATTERN.test(name)
    || byteLength(name) > LIMITS.maxPartNameBytes) invalidBody()
}

function decodeFilePart(value: Record<string, unknown>): {
  part: ProviderWireMultipartPart
  bytes: Buffer
} {
  requireExactKeys(value, ['bytesBase64', 'contentType', 'fileName', 'kind', 'name'])
  validatePartName(value.name)
  if (typeof value.fileName !== 'string'
    || !value.fileName
    || byteLength(value.fileName) > LIMITS.maxFileNameBytes
    || /[\u0000-\u001f/\\]/.test(value.fileName)) invalidBody()
  if (typeof value.contentType !== 'string'
    || byteLength(value.contentType) > LIMITS.maxContentTypeBytes
    || !CONTENT_TYPE_PATTERN.test(value.contentType)) invalidBody()
  if (typeof value.bytesBase64 !== 'string'
    || value.bytesBase64.length === 0
    || value.bytesBase64.length % 4 !== 0
    || !BASE64_PATTERN.test(value.bytesBase64)) invalidBody()
  const bytes = Buffer.from(value.bytesBase64, 'base64')
  return { part: value as ProviderWireMultipartPart, bytes }
}

function appendMultipartPart(
  form: FormData,
  value: unknown,
  totals: { files: number; fileBytes: number; textBytes: number },
): void {
  const part = record(value)
  if (part.kind === 'text') {
    requireExactKeys(part, ['kind', 'name', 'value'])
    validatePartName(part.name)
    if (typeof part.value !== 'string') invalidBody()
    const size = byteLength(part.value)
    totals.textBytes += size
    if (size > LIMITS.maxMultipartTextBytes
      || totals.textBytes > LIMITS.maxMultipartTextBatchBytes) invalidBody()
    form.append(part.name, part.value)
    return
  }
  if (part.kind !== 'file') invalidBody()
  const decoded = decodeFilePart(part)
  totals.files += 1
  totals.fileBytes += decoded.bytes.byteLength
  if (decoded.bytes.byteLength === 0
    || decoded.bytes.byteLength > LIMITS.maxMultipartFileBytes
    || totals.files > LIMITS.maxMultipartFiles
    || totals.fileBytes > LIMITS.maxMultipartBatchBytes) invalidBody()
  const file = decoded.part as Extract<ProviderWireMultipartPart, { kind: 'file' }>
  form.append(file.name, new Blob([decoded.bytes], { type: file.contentType }), file.fileName)
}

function multipartBody(body: Record<string, unknown>): FormData {
  requireExactKeys(body, ['kind', 'parts'])
  if (!Array.isArray(body.parts)
    || body.parts.length === 0
    || body.parts.length > LIMITS.maxMultipartParts) invalidBody()
  const form = new FormData()
  const totals = { files: 0, fileBytes: 0, textBytes: 0 }
  for (const part of body.parts) appendMultipartPart(form, part, totals)
  return form
}

function jsonBody(body: Record<string, unknown>): string {
  requireExactKeys(body, ['json', 'kind'])
  if (typeof body.json !== 'string' || byteLength(body.json) > LIMITS.maxJsonBytes) invalidBody()
  try {
    JSON.parse(body.json)
  } catch {
    return invalidBody()
  }
  return body.json
}

export function parseRelayEnvelope(source: Uint8Array): RelayUpstreamRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(source).toString('utf8'))
  } catch {
    return invalidBody()
  }
  const envelope = record(parsed)
  requireExactKeys(envelope, ['body', 'requestId', 'target'])
  if (typeof envelope.requestId !== 'string'
    || !isValidProviderRequestId(envelope.requestId)) invalidBody()
  const route = resolveModelPreviewRoute(envelope.target)
  const body = record(envelope.body)
  if (body.kind !== route.bodyKind) invalidBody()
  if (body.kind === 'none') {
    requireExactKeys(body, ['kind'])
    return { route }
  }
  if (body.kind === 'json') {
    return { route, body: jsonBody(body), contentType: 'application/json' }
  }
  if (body.kind === 'multipart') {
    return { route, body: multipartBody(body) }
  }
  return invalidBody()
}
