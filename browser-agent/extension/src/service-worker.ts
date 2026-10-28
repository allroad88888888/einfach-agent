import { CHANNEL, isRequest, type ExtensionResponse, type TargetBinding } from './protocol'
import { isDomActionResult, isDomSnapshot } from '@einfach-agent/tools-browser-dom'
import { disposeRemovedOrigins, syncRegisteredScripts } from './script-registration'

// Chrome's automatic side-panel action toggles the panel before granting activeTab access.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
chrome.action.onClicked.addListener((tab) => {
  if (Number.isInteger(tab.windowId)) void chrome.sidePanel.open({ windowId: tab.windowId as number }).catch(() => {})
})
void syncScriptsBestEffort()
chrome.runtime.onInstalled.addListener(() => { void syncScriptsBestEffort() })
chrome.runtime.onStartup.addListener(() => { void syncScriptsBestEffort() })
chrome.permissions.onAdded.addListener(() => { void syncScriptsBestEffort() })
chrome.permissions.onRemoved.addListener((permissions) => { void syncScriptsBestEffort(); void disposeRemovedOrigins(permissions.origins ?? []) })

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isRequest(message)) return
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    respond({ ok: false, code: 'UNTRUSTED_SENDER', error: 'Extension request sender was rejected.' } satisfies ExtensionResponse)
    return
  }
  void route(message).then(respond)
  return true
})

async function route(message: unknown): Promise<ExtensionResponse> {
  try {
    if (!isRequest(message)) throw new Error('Invalid extension request')
    const tabId = message.kind === 'handshake' ? message.tabId : message.target.tabId
    const frameId = message.kind === 'handshake' ? message.frameId : message.target.frameId
    if (message.kind === 'handshake') {
      await syncRegisteredScripts()
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', files: ['content-script.js'] })
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', files: ['network-main.js'] })
    }
    if (message.kind === 'network-call' || message.kind === 'cancel-network-call') return await routeNetwork(message)
    // PageRef.documentId is the content host's logical document generation, not Chrome's
    // native documentId. Route to the pinned frame and let that document validate the
    // logical generation; after navigation the old listener is gone and the new one rejects it.
    const result = await chrome.tabs.sendMessage(tabId, message, { frameId })
    if (!isExtensionResponse(result) || !validResult(message, result)) throw new Error('Content script returned an invalid response')
    if (message.kind !== 'handshake' && result.ok && !sameDocument(message.target, result.data)) {
      return { ok: false, code: 'INVALID_PAGE_RESULT', error: 'Content script result did not match the bound document.' }
    }
    return result
  } catch (error) {
    const unknownResult = isWriteCall(message) ? { unknownResult: true as const } : {}
    return { ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', error: error instanceof Error ? error.message : 'Content script is unavailable.', ...unknownResult }
  }
}

async function routeNetwork(message: Extract<import('./protocol').ExtensionRequest, { kind: 'network-call' | 'cancel-network-call' }>): Promise<ExtensionResponse> {
  const probe = await chrome.scripting.executeScript({
    target: { tabId: message.target.tabId, frameIds: [message.target.frameId] }, world: 'ISOLATED',
    func: () => ({ ...(globalThis as { __einfachBrowserAgentBinding__?: object }).__einfachBrowserAgentBinding__, url: location.href }),
  })
  const binding = probe[0]?.result
  const nativeDocumentId = probe[0]?.documentId
  if (!nativeDocumentId || !sameBinding(binding, message.target)) return { ok: false, code: 'STALE_DOCUMENT', error: 'The bound page document is no longer available.' }
  if (message.kind === 'network-call' && (binding as { url?: string }).url !== message.target.url) return { ok: false, code: 'PAGE_URL_CHANGED', error: 'The page URL has changed. Rebind the page before continuing.' }
  if (message.kind === 'cancel-network-call') {
    await chrome.scripting.executeScript({ target: { tabId: message.target.tabId, documentIds: [nativeDocumentId] }, world: 'MAIN',
      func: (sessionId: string, requestId: string) => (globalThis as { __einfachBrowserAgentNetworkGateway__?: { cancel(sessionId: string, requestId: string): void } }).__einfachBrowserAgentNetworkGateway__?.cancel(sessionId, requestId),
      args: [message.sessionId, message.requestId] })
    return { ok: true, data: null }
  }
  const result = await chrome.scripting.executeScript({ target: { tabId: message.target.tabId, documentIds: [nativeDocumentId] }, world: 'MAIN',
    func: async (sessionId: string, targetId: string, documentId: string, requestId: string, method: import('./protocol').NetworkMethod, input: unknown) => {
      try {
        const gateway = (globalThis as { __einfachBrowserAgentNetworkGateway__?: { call(...args: [string, string, string, string, import('./protocol').NetworkMethod, unknown]): Promise<unknown> } }).__einfachBrowserAgentNetworkGateway__
        if (!gateway) throw new Error('The page network recorder is unavailable.')
        const data = await gateway.call(sessionId, targetId, documentId, requestId, method, input)
        const encoded = JSON.stringify(data)
        if (!encoded || encoded.length > 200_000) throw new Error('The page network result exceeded its transfer limit.')
        return { ok: true as const, data }
      } catch (error) {
        const item = error as { code?: unknown; message?: unknown }
        const suffix = typeof item.code === 'string' && item.code.length <= 100 ? item.code : 'CALL_FAILED'
        const detail = typeof item.message === 'string' && item.message.length <= 1_024 ? item.message : 'Page network call failed.'
        return { ok: false as const, code: `NETWORK_${suffix}`, error: detail }
      }
    }, args: [message.sessionId, message.target.targetId, message.target.documentId, message.requestId, message.method, message.input] })
  const wire = result[0]?.result
  if (isNetworkEnvelope(wire) && !wire.ok) return { ok: false, code: wire.code, error: wire.error }
  const data = isNetworkEnvelope(wire) ? wire.data : wire
  if (!validNetworkResult(message.method, data)) return { ok: false, code: 'INVALID_NETWORK_RESULT', error: 'The page returned an invalid network result.' }
  return { ok: true, data }
}

function isNetworkEnvelope(value: unknown): value is { ok: true; data: unknown } | { ok: false; code: string; error: string } {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') return false
  const item = value as Record<string, unknown>
  return item.ok === true ? 'data' in item : bounded(item.code, 200) && bounded(item.error, 1_024)
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}
function validResult(request: import('./protocol').ExtensionRequest, response: ExtensionResponse): boolean {
  if (!response.ok) return typeof response.code === 'string' && typeof response.error === 'string'
  if (request.kind === 'cancel-page-call') return Array.isArray(response.data)
  if (request.kind === 'cancel-network-call') return response.data === null
  if (request.kind === 'network-call') return validNetworkResult(request.method, response.data)
  if (request.kind === 'handshake') {
    const data = response.data as Partial<TargetBinding>
    return Number.isInteger(data.tabId) && Number.isInteger(data.frameId) && typeof data.targetId === 'string' && typeof data.documentId === 'string' && Number.isInteger(data.revision) && typeof data.title === 'string' && typeof data.url === 'string'
  }
  if (request.method === 'readForm') return Boolean(response.data && typeof response.data === 'object' && 'page' in response.data && Array.isArray((response.data as { fields?: unknown }).fields))
  if (request.method === 'readPage') return Boolean(response.data && typeof response.data === 'object' && 'page' in response.data && typeof (response.data as { text?: unknown }).text === 'string' && Array.isArray((response.data as { tables?: unknown }).tables))
  if (request.method === 'readTable') return Boolean(response.data && typeof response.data === 'object' && 'page' in response.data && Array.isArray((response.data as { headers?: unknown }).headers) && Array.isArray((response.data as { rows?: unknown }).rows))
  if (request.method === 'readDom' || request.method === 'waitForDom') return isDomSnapshot(response.data)
  if (request.method === 'clickDom' || request.method === 'typeDom' || request.method === 'pressDomKey' || request.method === 'scrollDom') return isDomActionResult(response.data)
  return Array.isArray(response.data) && response.data.every((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { ok?: unknown }).ok === 'boolean')
}

function sameBinding(value: unknown, target: TargetBinding): boolean {
  return Boolean(value && typeof value === 'object' && (value as { targetId?: unknown }).targetId === target.targetId && (value as { documentId?: unknown }).documentId === target.documentId && (value as { revision?: unknown }).revision === target.revision)
}
function validNetworkResult(method: import('./protocol').NetworkMethod, value: unknown): value is import('./protocol').NetworkResult {
  if (!value || typeof value !== 'object' || !withinTransferLimit(value)) return false
  const item = value as Record<string, unknown>
  if (method === 'listRequests') return validCapture(item.capture) && Array.isArray(item.requests) && item.requests.length <= 100 && item.requests.every(validSummary) && optionalInteger(item.nextOffset)
  if (method === 'getResponse') return bounded(item.requestId, 500) && bounded(item.url, 4096) && optionalStatus(item.status) && validHeaders(item.headers) && optionalBounded(item.body, 65536) && ['pending', 'captured', 'omitted', 'error'].includes(String(item.bodyState)) && typeof item.truncated === 'boolean' && optionalBounded(item.reason, 1024)
  if (method === 'getRequest') return validSummary(item) && validHeaders(item.requestHeaders) && optionalBounded(item.requestBody, 65536) && ['pending', 'captured', 'omitted'].includes(String(item.requestBodyState)) && typeof item.requestBodyTruncated === 'boolean'
  if (method === 'waitForRequest') return validSummary(item)
  return validCapture(item)
}
function validCapture(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return bounded(item.captureId, 500) && bounded(item.targetId, 500) && bounded(item.documentId, 500)
    && typeof item.active === 'boolean' && nonNegative(item.startedAt) && nonNegative(item.recordingStartedAt)
    && (item.scope === 'document' || item.scope === 'capture')
    && optionalNonNegative(item.stoppedAt) && integer(item.count) && integer(item.droppedCount)
}
function validSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return bounded(item.requestId, 500) && bounded(item.url, 4096) && bounded(item.method, 32) && ['fetch', 'xhr'].includes(String(item.resourceType)) && ['pending', 'complete', 'error'].includes(String(item.state)) && nonNegative(item.startedAt) && optionalNonNegative(item.durationMs) && optionalStatus(item.status)
}
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function optionalBounded(value: unknown, max: number): boolean { return value === undefined || (typeof value === 'string' && value.length <= max) }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function optionalNonNegative(value: unknown): boolean { return value === undefined || nonNegative(value) }
function integer(value: unknown): boolean { return Number.isInteger(value) && nonNegative(value) }
function optionalInteger(value: unknown): boolean { return value === undefined || integer(value) }
function optionalStatus(value: unknown): boolean { return value === undefined || (integer(value) && (value as number) <= 999) }
function validHeaders(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 100 && entries.every(([key, item]) => key.length > 0 && key.length <= 256 && typeof item === 'string' && item.length <= 8192)
}
function withinTransferLimit(value: unknown): boolean { try { const encoded = JSON.stringify(value); return Boolean(encoded && encoded.length <= 200_000) } catch { return false } }
async function syncScriptsBestEffort(): Promise<void> { try { await syncRegisteredScripts() } catch { /* A later lifecycle event or handshake retries registration. */ } }
function isWriteCall(message: unknown): boolean {
  return isRequest(message) && message.kind === 'page-call' && ['fillFields', 'clickDom', 'typeDom', 'pressDomKey', 'scrollDom'].includes(message.method)
}
function sameDocument(target: TargetBinding, data: unknown): boolean {
  if (!data || typeof data !== 'object' || !('page' in data)) return true
  const page = (data as { page?: unknown }).page
  return Boolean(page && typeof page === 'object' && (page as { documentId?: unknown }).documentId === target.documentId && (page as { revision?: unknown }).revision === target.revision)
}
