import { sanitizeBody, sanitizeHeaders, sanitizeUrl } from './sanitize'
import type { NetworkRequestDetails, NetworkResponseDetails, ObservedRecord } from './types'
import { addRecordCleanup, cleanupRecord, readBounded, removeRecordCleanup } from './observer-resources'
import { captureRequestBody, isRequestLike, serializeDirectBody } from './request-input'
import { cloneRecord, constrainRecordBodies, isRecordAlive } from './observed-record'
type Listener = (record: ObservedRecord) => void
interface Observer {
  document: Document
  startedAt: number
  droppedCount: number
  records: ObservedRecord[]
  listeners: Set<Listener>
  pagehideListeners: Set<() => void>
  recorderRefs: number
  hookRefs: number
  maxRequests: number
  maxBodyChars: number
  maxAgeMs?: number
  readers: Set<ReadableStreamDefaultReader<Uint8Array>>
  listenerCleanups: Set<() => void>
  recordCleanups: Map<ObservedRecord, Set<() => void>>
  pruneTimer?: ReturnType<typeof setInterval>
  disposeHook(): void
}
const observers = new WeakMap<Window, Observer>()
let sequence = 0
export function retainObserver(window: Window, options: { maxRequests: number; maxBodyChars: number; maxAgeMs?: number }, recorder: boolean): Observer {
  let observer = observers.get(window)
  if (!observer || observer.document !== window.document) {
    observer = createObserver(window, options)
    observers.set(window, observer)
  } else if (recorder && observer.recorderRefs === 0) {
    for (const record of observer.records.splice(0)) cleanupRecord(observer, record)
    observer.maxRequests = options.maxRequests
    observer.maxBodyChars = options.maxBodyChars
    observer.maxAgeMs = options.maxAgeMs
    resetPruneTimer(observer)
  } else if (recorder) {
    observer.maxRequests = Math.min(observer.maxRequests, options.maxRequests)
    const nextBodyChars = Math.min(observer.maxBodyChars, options.maxBodyChars)
    if (nextBodyChars !== observer.maxBodyChars) {
      observer.maxBodyChars = nextBodyChars
      for (const record of observer.records) constrainRecordBodies(record, nextBodyChars)
    }
    const nextAge = minimumAge(observer.maxAgeMs, options.maxAgeMs)
    if (nextAge !== observer.maxAgeMs) {
      observer.maxAgeMs = nextAge
      resetPruneTimer(observer)
    }
    prune(observer)
  } else if (observer.recorderRefs === 0) {
    observer.maxRequests = Math.max(observer.maxRequests, options.maxRequests)
    observer.maxBodyChars = Math.max(observer.maxBodyChars, options.maxBodyChars)
  }
  observer.hookRefs++
  if (recorder) observer.recorderRefs++
  return observer
}
export function retainInstalledObserver(window: Window): Observer | undefined {
  const observer = observers.get(window)
  if (!observer || observer.document !== window.document || observer.recorderRefs === 0) return undefined
  observer.hookRefs++
  return observer
}
export function releaseObserver(window: Window, observer: Observer, recorder: boolean): void {
  if (observers.get(window) !== observer) return
  if (recorder) observer.recorderRefs = Math.max(0, observer.recorderRefs - 1)
  observer.hookRefs = Math.max(0, observer.hookRefs - 1)
  if (observer.hookRefs === 0) { observer.disposeHook(); observer.records.length = 0; observers.delete(window) }
}
export function observerSnapshot(observer: Observer): ObservedRecord[] {
  prune(observer)
  return observer.records.map(cloneRecord)
}
export function observerStatus(observer: Observer): { startedAt: number; droppedCount: number } {
  prune(observer)
  return { startedAt: observer.startedAt, droppedCount: observer.droppedCount }
}
export function subscribeObserver(observer: Observer, listener: Listener): () => void {
  observer.listeners.add(listener); return () => observer.listeners.delete(listener)
}
export function subscribeObserverPagehide(observer: Observer, listener: () => void): () => void {
  observer.pagehideListeners.add(listener)
  return () => observer.pagehideListeners.delete(listener)
}
function createObserver(window: Window, limits: { maxRequests: number; maxBodyChars: number; maxAgeMs?: number }): Observer {
  const realm = window as Window & typeof globalThis
  const observer: Observer = {
    document: window.document,
    startedAt: Date.now(),
    droppedCount: 0,
    records: [],
    listeners: new Set(),
    pagehideListeners: new Set(),
    readers: new Set(),
    listenerCleanups: new Set(),
    recordCleanups: new Map(),
    recorderRefs: 0,
    hookRefs: 0,
    ...limits,
    disposeHook: () => {},
  }
  resetPruneTimer(observer)
  const originalFetch = window.fetch
  const xhr = realm.XMLHttpRequest?.prototype
  const originalOpen = xhr?.open; const originalSend = xhr?.send; const originalSetHeader = xhr?.setRequestHeader
  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Headers; record?: ObservedRecord }>()
  const wrappedFetch: typeof fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let record: ObservedRecord | undefined
    try {
      const request = isRequestLike(input) ? input : undefined
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
      const url = sanitizeUrl(request?.url ?? String(input), window.location.href)
      const headers = new Headers(request?.headers)
      new Headers(init?.headers).forEach((v, k) => headers.set(k, v))
      if (init?.body instanceof URLSearchParams && !headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
      }
      const directBody = serializeDirectBody(init?.body)
      record = begin(observer, 'fetch', method, url, headers, directBody, directBody === undefined && Boolean(request?.body))
      if (directBody === undefined && request?.body) {
        void captureRequestBody(observer, record, request.clone(), headers.get('content-type') ?? '', (updated) => emit(observer, updated))
      }
    } catch { /* Observation must never alter the page request. */ }
    let promise: Promise<Response>
    try { promise = Reflect.apply(originalFetch, this, arguments as unknown as [RequestInfo | URL, RequestInit?]) as Promise<Response> }
    catch (error) { if (record) finishError(observer, record); throw error }
    if (record) promise.then((response) => { void finishFetch(observer, record!, response) }, () => finishError(observer, record!))
    return promise
  }
  window.fetch = wrappedFetch
  if (xhr && originalOpen && originalSend && originalSetHeader) {
    const wrappedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const result = Reflect.apply(originalOpen, this, [method, url, ...rest])
      try {
        xhrMeta.set(this, {
          method: method.toUpperCase(),
          url: sanitizeUrl(String(url), window.location.href),
          headers: new Headers(),
        })
      } catch { /* Observation is best effort. */ }
      return result
    } as typeof xhr.open
    const wrappedSetHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const result = originalSetHeader.call(this, name, value)
      try { xhrMeta.get(this)?.headers.append(name, value) } catch { /* Observation is best effort. */ }
      return result
    }
    const wrappedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = xhrMeta.get(this) ?? { method: 'GET', url: 'about:invalid', headers: new Headers() }
      let record: ObservedRecord | undefined
      try {
        record = begin(observer, 'xhr', meta.method, meta.url, meta.headers, typeof body === 'string' ? body : undefined)
        meta.record = record
      } catch { /* Preserve XHR behavior. */ }
      if (!record) return originalSend.call(this, body)
      const captured = record
      const cleanup = () => {
        this.removeEventListener('load', loaded)
        this.removeEventListener('error', failed)
        this.removeEventListener('abort', failed)
        this.removeEventListener('timeout', failed)
        observer.listenerCleanups.delete(cleanup)
        removeRecordCleanup(observer, captured, cleanup)
      }
      const loaded = () => { cleanup(); finishXhr(observer, captured, this) }
      const failed = () => { cleanup(); finishError(observer, captured) }
      this.addEventListener('load', loaded); this.addEventListener('error', failed); this.addEventListener('abort', failed); this.addEventListener('timeout', failed)
      observer.listenerCleanups.add(cleanup)
      addRecordCleanup(observer, captured, cleanup)
      try { return originalSend.call(this, body) } catch (error) { cleanup(); finishError(observer, captured); throw error }
    }
    xhr.open = wrappedOpen; xhr.setRequestHeader = wrappedSetHeader; xhr.send = wrappedSend
    observer.disposeHook = () => {
      if (window.fetch === wrappedFetch) window.fetch = originalFetch
      if (xhr.open === wrappedOpen) xhr.open = originalOpen
      if (xhr.send === wrappedSend) xhr.send = originalSend
      if (xhr.setRequestHeader === wrappedSetHeader) xhr.setRequestHeader = originalSetHeader
      for (const reader of observer.readers) void reader.cancel().catch(() => undefined)
      observer.readers.clear()
      for (const cleanup of observer.listenerCleanups) cleanup()
      observer.listenerCleanups.clear()
      observer.recordCleanups.clear()
      clearInterval(observer.pruneTimer)
      window.removeEventListener('pagehide', pagehide); observer.listeners.clear()
    }
  }
  const pagehide = () => {
    for (const listener of [...observer.pagehideListeners]) listener()
    observer.pagehideListeners.clear()
    observer.disposeHook()
    observer.records.length = 0
    observers.delete(window)
  }
  window.addEventListener('pagehide', pagehide)
  if (!xhr || !originalOpen || !originalSend || !originalSetHeader) observer.disposeHook = () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch
    for (const reader of observer.readers) void reader.cancel().catch(() => undefined)
    observer.readers.clear()
    for (const cleanup of observer.listenerCleanups) cleanup()
    observer.listenerCleanups.clear()
    observer.recordCleanups.clear()
    clearInterval(observer.pruneTimer)
    window.removeEventListener('pagehide', pagehide); observer.listeners.clear()
  }
  return observer
}
function begin(observer: Observer, resourceType: 'fetch' | 'xhr', method: string, url: string, headers: Headers, body?: string, bodyPending = false): ObservedRecord {
  const startedAt = Date.now(); const requestId = `network-${startedAt}-${++sequence}`
  const contentType = headers.get('content-type') ?? 'text/plain'
  const sanitized = body === undefined ? undefined : sanitizeBody(body, contentType, observer.maxBodyChars)
  const request: NetworkRequestDetails = {
    requestId,
    url,
    method,
    resourceType,
    state: 'pending',
    startedAt,
    requestHeaders: sanitizeHeaders(headers),
    requestBody: sanitized?.body,
    requestBodyState: bodyPending ? 'pending' : body === undefined ? 'omitted' : sanitized?.state ?? 'omitted',
    requestBodyTruncated: sanitized?.truncated ?? false,
  }
  const response: NetworkResponseDetails = { requestId, url, headers: {}, bodyState: 'pending', truncated: false }
  const record = { request, response, document: observer.document }; observer.records.push(record); prune(observer); emit(observer, record); return record
}
async function finishFetch(observer: Observer, record: ObservedRecord, response: Response): Promise<void> {
  if (!observer.records.includes(record)) return
  const headers = sanitizeHeaders(response.headers); const contentType = response.headers.get('content-type') ?? ''
  if (response.type === 'opaque' || /text\/event-stream/i.test(contentType) || !response.body) {
    record.response = {
      ...record.response,
      status: response.status,
      headers,
      bodyState: 'omitted',
      reason: 'response body is not safely readable',
    }
  } else {
    try {
      const cloneBody = response.clone().body
      if (!cloneBody) throw new Error('unreadable')
      const bodyLimit = observer.maxBodyChars
      const text = await readBounded(observer, cloneBody, bodyLimit + 4, record)
      if (!isRecordAlive(observer.document, observer.records, record)) return
      const safe = sanitizeBody(text, contentType, Math.min(bodyLimit, observer.maxBodyChars))
      record.response = {
        ...record.response,
        status: response.status,
        headers,
        body: safe.body,
        bodyState: safe.state,
        truncated: safe.truncated,
        reason: safe.reason,
      }
    } catch {
      if (!isRecordAlive(observer.document, observer.records, record)) return
      record.response = {
        ...record.response,
        status: response.status,
        headers,
        bodyState: 'error',
        reason: 'response body could not be read',
      }
    }
  }
  record.request = { ...record.request, state: 'complete', status: response.status, durationMs: Date.now() - record.request.startedAt }
  emit(observer, record)
}
function finishXhr(observer: Observer, record: ObservedRecord, xhr: XMLHttpRequest): void {
  const contentType = xhr.getResponseHeader('content-type') ?? ''
  let safe = {
    state: 'omitted' as const,
    truncated: false,
    reason: 'response body is not safely readable',
    body: undefined as string | undefined,
  }
  if ((xhr.responseType === '' || xhr.responseType === 'text') && typeof xhr.responseText === 'string') {
    safe = sanitizeBody(xhr.responseText, contentType, observer.maxBodyChars) as typeof safe
  }
  if (xhr.responseType === 'json') {
    try { safe = sanitizeBody(JSON.stringify(xhr.response), 'application/json', observer.maxBodyChars) as typeof safe }
    catch { safe = { state: 'omitted', truncated: false, reason: 'response body was not safe JSON', body: undefined } }
  }
  record.request = { ...record.request, state: 'complete', status: xhr.status, durationMs: Date.now() - record.request.startedAt }
  record.response = { ...record.response, status: xhr.status, headers: sanitizeHeaders(xhr.getAllResponseHeaders()), ...safe, bodyState: safe.state }
  emit(observer, record)
}
function finishError(observer: Observer, record: ObservedRecord): void {
  if (!isRecordAlive(observer.document, observer.records, record)) return
  record.request = {
    ...record.request,
    state: 'error',
    durationMs: Date.now() - record.request.startedAt,
  }
  record.response = { ...record.response, bodyState: 'error', reason: 'request failed' }
  emit(observer, record)
}
function emit(observer: Observer, record: ObservedRecord): void { for (const listener of observer.listeners) listener(cloneRecord(record)) }
function prune(observer: Observer): void {
  if (observer.maxAgeMs !== undefined) {
    const cutoff = Date.now() - observer.maxAgeMs
    const firstCurrent = observer.records.findIndex((record) => record.request.startedAt >= cutoff)
    const expired = firstCurrent < 0 ? observer.records.splice(0) : observer.records.splice(0, firstCurrent)
    observer.droppedCount += expired.length
    for (const record of expired) cleanupRecord(observer, record)
  }
  while (observer.records.length > observer.maxRequests) {
    const dropped = observer.records.shift()
    if (dropped) { observer.droppedCount++; cleanupRecord(observer, dropped) }
  }
}
function resetPruneTimer(observer: Observer): void {
  clearInterval(observer.pruneTimer)
  if (observer.maxAgeMs !== undefined) observer.pruneTimer = setInterval(() => prune(observer), Math.min(observer.maxAgeMs, 30_000))
}
function minimumAge(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}
