import type { ObservedRecord } from './types'
import { sanitizeBody } from './sanitize'

export function cloneRecord(record: ObservedRecord): ObservedRecord {
  return {
    document: record.document,
    request: { ...record.request, requestHeaders: { ...record.request.requestHeaders } },
    response: { ...record.response, headers: { ...record.response.headers } },
  }
}

export function isRecordAlive(document: Document, records: readonly ObservedRecord[], record: ObservedRecord): boolean {
  return record.document === document && records.includes(record)
}

export function constrainRecordBodies(record: ObservedRecord, limit: number): void {
  const requestBody = record.request.requestBody
  if (requestBody !== undefined && requestBody.length > limit) {
    const safe = sanitizeBody(requestBody, record.request.requestHeaders['content-type'] ?? '', limit)
    record.request = {
      ...record.request,
      requestBody: safe.body,
      requestBodyState: safe.state,
      requestBodyTruncated: safe.truncated,
    }
  }
  const responseBody = record.response.body
  if (responseBody !== undefined && responseBody.length > limit) {
    const safe = sanitizeBody(responseBody, record.response.headers['content-type'] ?? '', limit)
    record.response = {
      ...record.response,
      body: safe.body,
      bodyState: safe.state,
      truncated: safe.truncated,
      reason: safe.reason,
    }
  }
}
