export function isRequestLike(input: RequestInfo | URL): input is Request {
  return typeof input === 'object'
    && input !== null
    && 'url' in input
    && 'method' in input
    && 'headers' in input
}

export function serializeDirectBody(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return undefined
}

interface RequestBodyOwner extends ObserverResources {
  document: Document
  records: ObservedRecord[]
  maxBodyChars: number
}

export async function captureRequestBody(
  owner: RequestBodyOwner,
  record: ObservedRecord,
  request: Request,
  contentType: string,
  emit: (record: ObservedRecord) => void,
): Promise<void> {
  if (!request.body || record.document !== owner.document || !owner.records.includes(record)) return
  try {
    const bodyLimit = owner.maxBodyChars
    const text = await readBounded(owner, request.body, bodyLimit + 4, record)
    if (record.document !== owner.document || !owner.records.includes(record)) return
    const safe = sanitizeBody(text, contentType, Math.min(bodyLimit, owner.maxBodyChars))
    record.request = {
      ...record.request,
      requestBody: safe.body,
      requestBodyState: safe.state,
      requestBodyTruncated: safe.truncated,
    }
    emit(record)
  } catch {
    if (record.document !== owner.document || !owner.records.includes(record)) return
    record.request = { ...record.request, requestBodyState: 'omitted', requestBodyTruncated: false }
  }
}
import { readBounded, type ObserverResources } from './observer-resources'
import { sanitizeBody } from './sanitize'
import type { ObservedRecord } from './types'
