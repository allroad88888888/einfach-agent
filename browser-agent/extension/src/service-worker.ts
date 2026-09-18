import { CHANNEL, isRequest, type ExtensionResponse, type TargetBinding } from './protocol'

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

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
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content-script.js'] })
    }
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
    return { ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', error: error instanceof Error ? error.message : 'Content script is unavailable.', unknownResult: true }
  }
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
}
function validResult(request: import('./protocol').ExtensionRequest, response: ExtensionResponse): boolean {
  if (!response.ok) return typeof response.code === 'string' && typeof response.error === 'string'
  if (request.kind === 'cancel-page-call') return Array.isArray(response.data)
  if (request.kind === 'handshake') {
    const data = response.data as Partial<TargetBinding>
    return Number.isInteger(data.tabId) && Number.isInteger(data.frameId) && typeof data.targetId === 'string' && typeof data.documentId === 'string' && Number.isInteger(data.revision) && typeof data.title === 'string' && typeof data.url === 'string'
  }
  if (request.method === 'readForm') return Boolean(response.data && typeof response.data === 'object' && 'page' in response.data && Array.isArray((response.data as { fields?: unknown }).fields))
  return Array.isArray(response.data) && response.data.every((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { ok?: unknown }).ok === 'boolean')
}
function sameDocument(target: TargetBinding, data: unknown): boolean {
  if (!data || typeof data !== 'object' || !('page' in data)) return true
  const page = (data as { page?: unknown }).page
  return Boolean(page && typeof page === 'object' && (page as { documentId?: unknown }).documentId === target.documentId && (page as { revision?: unknown }).revision === target.revision)
}
