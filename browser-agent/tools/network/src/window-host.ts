import { fail, NetworkToolsError } from './network-error'
import { assertCallContext, validateCaptureInput, validateCaptureOptions, validateId, validateList, validateRequestInput, validateWait } from './host-input-validation'
import type { CaptureStatus, NetworkCaptureOptions, NetworkListInput, NetworkListResult, NetworkRequestDetails, NetworkRequestSummary, NetworkResponseDetails, NetworkToolsHost, NetworkWaitInput, ObservedRecord, RequestInput, WindowNetworkRecorderOptions } from './types'
import { observerSnapshot, observerStatus, releaseObserver, retainInstalledObserver, retainObserver, subscribeObserver, subscribeObserverPagehide } from './window-observer'

interface Capture {
  id: string
  sessionId: string
  active: boolean
  startedAt: number
  stoppedAt?: number
  records: ObservedRecord[]
  droppedCount: number
  filter: NetworkCaptureOptions
  excludedRequestIds: Set<string>
  droppedRequestIds: Set<string>
  observer: ReturnType<typeof retainObserver>
  unsubscribe?: () => void
  unsubscribePagehide?: () => void
  timer?: ReturnType<typeof setTimeout>
  stoppedListeners: Set<() => void>
  scope: 'document' | 'capture'
}
let captureSequence = 0
let documentSequence = 0
const documentIds = new WeakMap<Document, string>()

export function createWindowNetworkHost(options: WindowNetworkRecorderOptions & { targetId: string; documentId?: string; maxDurationMs?: number }): NetworkToolsHost & { dispose(): void } {
  if (!options.targetId?.trim()) fail('INVALID_INPUT')
  const document = options.window.document
  const documentId = options.documentId ?? getDocumentId(document)
  const limits = { maxRequests: valid(options.maxRequests, 100, 1, 500), maxBodyChars: valid(options.maxBodyChars, 32768, 1, 65536), maxAgeMs: 600000 }
  const duration = valid(options.maxDurationMs, 300000, 1, 600000)
  const captures = new Map<string, Capture>()
  const documentViews = new Map<string, Capture>()
  let disposed = false

  function assertDocument(): void { if (disposed || options.window.document !== document) fail('DOCUMENT_CHANGED') }
  function owned(captureId: string, sessionId: string): Capture {
    validateId(captureId)
    assertDocument()
    const explicit = captures.get(sessionId)
    const documentView = documentViews.get(sessionId)
    const capture = explicit?.id === captureId ? explicit : documentView?.id === captureId ? documentView : undefined
    if (!capture || capture.id !== captureId) fail('CAPTURE_NOT_FOUND')
    return capture
  }
  function status(capture: Capture): CaptureStatus {
    return {
      captureId: capture.id,
      targetId: options.targetId,
      documentId,
      active: capture.active,
      startedAt: capture.startedAt,
      recordingStartedAt: observerStatus(capture.observer).startedAt,
      scope: capture.scope,
      stoppedAt: capture.stoppedAt,
      count: capture.records.length,
      droppedCount: capture.scope === 'document' ? observerStatus(capture.observer).droppedCount : capture.droppedCount,
    }
  }
  function append(capture: Capture, incoming: ObservedRecord): void {
    if (!capture.active || !matches(incoming.request, capture.filter)) return
    if (capture.droppedRequestIds.has(incoming.request.requestId)) {
      if (incoming.request.state !== 'pending') capture.droppedRequestIds.delete(incoming.request.requestId)
      return
    }
    const index = capture.records.findIndex((record) => record.request.requestId === incoming.request.requestId)
    const safeCopy = cloneForCapture(incoming, limits.maxBodyChars)
    if (index >= 0) capture.records[index] = safeCopy
    else capture.records.push(safeCopy)
    while (capture.records.length > limits.maxRequests) {
      const dropped = capture.records.shift()
      if (dropped?.request.state === 'pending') {
        capture.droppedRequestIds.add(dropped.request.requestId)
        while (capture.droppedRequestIds.size > 500) {
          const oldest = capture.droppedRequestIds.values().next().value
          if (oldest) capture.droppedRequestIds.delete(oldest)
        }
      }
      capture.droppedCount++
    }
  }
  function stop(capture: Capture): void {
    if (!capture.active) return
    capture.active = false
    capture.stoppedAt = Date.now()
    capture.unsubscribe?.()
    capture.unsubscribePagehide?.()
    clearTimeout(capture.timer)
    releaseObserver(options.window, capture.observer, false)
    for (const listener of capture.stoppedListeners) listener()
    capture.stoppedListeners.clear()
  }
  function documentView(sessionId: string): Capture {
    const existing = documentViews.get(sessionId)
    if (existing) return existing
    const observer = retainInstalledObserver(options.window)
    if (!observer) fail('RECORDER_UNAVAILABLE')
    const observerState = observerStatus(observer)
    const capture: Capture = {
      id: `document-${Date.now()}-${++captureSequence}`,
      sessionId,
      active: true,
      startedAt: observerState.startedAt,
      records: observerSnapshot(observer).map((record) => cloneForCapture(record, limits.maxBodyChars)),
      droppedCount: observerState.droppedCount,
      stoppedListeners: new Set(),
      observer,
      droppedRequestIds: new Set(),
      excludedRequestIds: new Set(),
      filter: {},
      scope: 'document',
    }
    capture.unsubscribe = subscribeObserver(observer, (record) => append(capture, record))
    capture.unsubscribePagehide = subscribeObserverPagehide(observer, () => stop(capture))
    documentViews.set(sessionId, capture)
    return capture
  }

  return {
    async startCapture(input, ctx) {
      assertCallContext(ctx)
      if (ctx.signal.aborted) fail('CANCELLED')
      validateCaptureOptions(input)
      assertDocument()
      const previous = captures.get(ctx.sessionId); if (previous) { stop(previous); captures.delete(ctx.sessionId) }
      const observer = retainObserver(options.window, limits, false)
      const buffered = observerSnapshot(observer)
      const capture: Capture = {
        id: `capture-${Date.now()}-${++captureSequence}`,
        sessionId: ctx.sessionId,
        active: true,
        startedAt: Date.now(),
        records: [],
        droppedCount: 0,
        stoppedListeners: new Set(),
        observer,
        droppedRequestIds: new Set(),
        excludedRequestIds: new Set(input.includeBuffered === false ? buffered.map((record) => record.request.requestId) : []),
        filter: { ...input, methods: input.methods?.map((method) => method.toUpperCase()) },
        scope: 'capture',
      }
      if (input.includeBuffered !== false) for (const record of buffered) append(capture, record)
      capture.unsubscribe = subscribeObserver(observer, (record) => {
        if (!capture.excludedRequestIds.has(record.request.requestId)) append(capture, record)
      })
      capture.unsubscribePagehide = subscribeObserverPagehide(observer, () => stop(capture))
      capture.timer = setTimeout(() => stop(capture), duration)
      captures.set(ctx.sessionId, capture); return status(capture)
    },
    async stopCapture(input, ctx) {
      assertCallContext(ctx)
      validateCaptureInput(input)
      const capture = captures.get(ctx.sessionId)
      if (!capture || capture.id !== input.captureId) fail('CAPTURE_NOT_FOUND')
      stop(capture)
      return status(capture)
    },
    async listRequests(input, ctx) {
      assertCallContext(ctx)
      validateList(input)
      const capture = input.captureId ? owned(input.captureId, ctx.sessionId) : documentView(ctx.sessionId)
      const filtered = capture.records.map((record) => record.request).filter((request) => matches(request, input))
      const offset = input.offset ?? 0
      const limit = input.limit ?? 20
      const requests = filtered.slice(offset, offset + limit).map(summary); const result: NetworkListResult = { capture: status(capture), requests }
      if (offset + requests.length < filtered.length) result.nextOffset = offset + requests.length
      return result
    },
    async getRequest(input, ctx) {
      assertCallContext(ctx)
      validateRequestInput(input)
      return clone(find(owned(input.captureId, ctx.sessionId), input)).request
    },
    async getResponse(input, ctx) {
      assertCallContext(ctx)
      validateRequestInput(input)
      return clone(find(owned(input.captureId, ctx.sessionId), input)).response
    },
    async waitForRequest(input, ctx) {
      assertCallContext(ctx)
      validateWait(input)
      const capture = owned(input.captureId, ctx.sessionId)
      const state = input.state ?? 'finished'
      const candidate = () => capture.records
        .map((record) => record.request)
        .find((request) => matches(request, input) && (state === 'started' || request.state !== 'pending'))
      if (ctx.signal.aborted) fail('CANCELLED')
      const existing = candidate(); if (existing) return summary(existing); if (!capture.active) fail('CAPTURE_STOPPED')
      return new Promise<NetworkRequestSummary>((resolve, reject) => {
        const timeout = setTimeout(() => done(() => reject(new NetworkToolsError('TIMEOUT'))), input.timeoutMs ?? 5000)
        const abort = () => done(() => reject(new NetworkToolsError('CANCELLED')))
        const unsubscribe = subscribeObserver(capture.observer, () => { const found = candidate(); if (found) done(() => resolve(summary(found))) })
        const stopped = () => done(() => reject(new NetworkToolsError('CAPTURE_STOPPED')))
        capture.stoppedListeners.add(stopped)
        const done = (finish: () => void) => {
          clearTimeout(timeout)
          unsubscribe()
          capture.stoppedListeners.delete(stopped)
          ctx.signal.removeEventListener('abort', abort)
          finish()
        }
        ctx.signal.addEventListener('abort', abort, { once: true })
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const capture of [...captures.values(), ...documentViews.values()]) stop(capture)
      captures.clear(); documentViews.clear()
    },
  }
}

function summary(request: NetworkRequestDetails): NetworkRequestSummary {
  const { requestHeaders: _, requestBody: _body, requestBodyState: _state, requestBodyTruncated: _truncated, ...value } = request
  return { ...value }
}
function clone(record: ObservedRecord): ObservedRecord {
  return {
    document: record.document,
    request: { ...record.request, requestHeaders: { ...record.request.requestHeaders } },
    response: { ...record.response, headers: { ...record.response.headers } },
  }
}
function cloneForCapture(record: ObservedRecord, maxBodyChars: number): ObservedRecord {
  const copy = clone(record)
  const requestType = copy.request.requestHeaders['content-type'] ?? ''
  const responseType = copy.response.headers['content-type'] ?? ''
  const requestBody = constrainBody(copy.request.requestBody, requestType, maxBodyChars)
  const responseBody = constrainBody(copy.response.body, responseType, maxBodyChars)
  copy.request.requestBody = requestBody.body
  copy.request.requestBodyState = requestBody.omitted ? 'omitted' : copy.request.requestBodyState
  copy.request.requestBodyTruncated ||= requestBody.truncated
  copy.response.body = responseBody.body
  copy.response.bodyState = responseBody.omitted ? 'omitted' : copy.response.bodyState
  copy.response.truncated ||= responseBody.truncated
  if (responseBody.omitted) copy.response.reason = 'response body exceeded capture limit'
  return copy
}
function constrainBody(
  body: string | undefined,
  contentType: string,
  limit: number,
): { body?: string; omitted: boolean; truncated: boolean } {
  if (body === undefined || body.length <= limit) return { body, omitted: false, truncated: false }
  if (/^text\/plain(?:;|$)/i.test(contentType) || /x-www-form-urlencoded/i.test(contentType)) {
    return { body: body.slice(0, limit), omitted: false, truncated: true }
  }
  return { omitted: true, truncated: true }
}
function find(capture: Capture, input: RequestInput): ObservedRecord {
  validateId(input.requestId)
  const record = capture.records.find((candidate) => candidate.request.requestId === input.requestId)
  if (!record) fail('REQUEST_NOT_FOUND')
  return record
}
function matches(
  request: NetworkRequestSummary,
  input: { urlIncludes?: string; method?: string; methods?: readonly string[] },
): boolean {
  return (!input.urlIncludes || request.url.includes(input.urlIncludes))
    && (!input.method || request.method === input.method.toUpperCase())
    && (!input.methods || input.methods.includes(request.method))
}
function valid(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < min || result > max) fail('INVALID_INPUT')
  return result
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function getDocumentId(document: Document): string {
  let id = documentIds.get(document)
  if (!id) { id = `document-${++documentSequence}`; documentIds.set(document, id) }
  return id
}
