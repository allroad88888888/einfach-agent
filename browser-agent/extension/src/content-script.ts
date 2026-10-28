import { createDomPageHost } from '@einfach-agent/tools-browser-page'
import { createDomToolsHost } from '@einfach-agent/tools-browser-dom'
import { CHANNEL, isRecord, isRequest, type ExtensionResponse, type PageRequest } from './protocol'

const marker = '__einfachBrowserAgentContentInstalled__'
const bindingMarker = '__einfachBrowserAgentBinding__'
const scope = globalThis as typeof globalThis & Record<string, unknown>
if (!scope[marker]) {
  scope[marker] = true
  let documentId = crypto.randomUUID()
  let revision = 1
  let pageUrl = location.href
  Object.defineProperty(scope, bindingMarker, { get() { refreshGeneration(); return Object.freeze({ targetId: 'main-frame', documentId, revision }) }, configurable: false, enumerable: false })
  let host = createDomPageHost({ document, targetId: 'main-frame', documentId, revision })
  let domHost = createDomToolsHost({ document, targetId: 'main-frame', documentId, revision })
  const active = new Map<string, AbortController>()
  function refreshGeneration(): void {
    if (pageUrl === location.href) return
    for (const controller of active.values()) controller.abort()
    active.clear()
    pageUrl = location.href; documentId = crypto.randomUUID(); revision++
    host = createDomPageHost({ document, targetId: 'main-frame', documentId, revision })
    domHost = createDomToolsHost({ document, targetId: 'main-frame', documentId, revision })
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRequest(message) || message.kind === 'handshake' || message.kind === 'network-call' || message.kind === 'cancel-network-call') return
    if (sender.id !== chrome.runtime.id) { respond({ ok: false, code: 'UNTRUSTED_SENDER', error: 'Page request sender was rejected.' } satisfies ExtensionResponse); return }
    refreshGeneration()
    if (message.target.documentId !== documentId || message.target.revision !== revision) {
      respond({ ok: false, code: 'STALE_DOCUMENT', error: 'The bound page document is no longer available.' } satisfies ExtensionResponse)
      return
    }
    if (message.kind === 'cancel-page-call') {
      active.get(message.requestId)?.abort()
      active.delete(message.requestId)
      respond({ ok: true, data: [] } satisfies ExtensionResponse)
      return
    }
    if (message.target.url !== location.href) {
      respond({ ok: false, code: 'PAGE_URL_CHANGED', error: 'The page URL has changed. Rebind the page before continuing.' } satisfies ExtensionResponse)
      return
    }
    void execute(message).then(respond)
    return true
  })

  async function execute(message: PageRequest): Promise<ExtensionResponse> {
    const controller = new AbortController()
    active.set(message.requestId, controller)
    const ctx = { sessionId: message.sessionId, signal: controller.signal }
    try {
      const data = message.method === 'readForm'
        ? await host.readForm(ctx)
        : message.method === 'readPage' && isRecord(message.input)
          ? await host.readPage!(message.input, ctx)
          : message.method === 'readTable' && isRecord(message.input) && isRecord(message.input.page) && typeof message.input.tableId === 'string'
            ? await host.readTable!({ page: message.input.page as never, tableId: message.input.tableId, offset: typeof message.input.offset === 'number' ? message.input.offset : undefined, limit: typeof message.input.limit === 'number' ? message.input.limit : undefined }, ctx)
        : message.method === 'fillFields' && isRecord(message.input) && Array.isArray(message.input.values)
          ? await host.fillFields({ page: message.input.page as never, values: message.input.values as never }, ctx)
        : message.method === 'validateForm' && isRecord(message.input)
            ? await host.validateForm({ page: message.input.page as never, fieldIds: Array.isArray(message.input.fieldIds) ? message.input.fieldIds as string[] : undefined }, ctx)
        : message.method === 'readDom' && isRecord(message.input)
          ? await domHost.readDom(message.input, ctx)
        : message.method === 'clickDom' && isRecord(message.input)
          ? await domHost.clickDom(message.input as never, ctx)
        : message.method === 'typeDom' && isRecord(message.input)
          ? await domHost.typeDom(message.input as never, ctx)
        : message.method === 'pressDomKey' && isRecord(message.input)
          ? await domHost.pressDomKey(message.input as never, ctx)
        : message.method === 'scrollDom' && isRecord(message.input)
          ? await domHost.scrollDom(message.input as never, ctx)
        : message.method === 'waitForDom' && isRecord(message.input)
          ? await domHost.waitForDom(message.input as never, ctx)
              : (() => { throw new Error('Invalid page call input') })()
      if (controller.signal.aborted) return { ok: false, code: 'PAGE_CALL_CANCELLED', error: 'The page call was cancelled.' }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, code: controller.signal.aborted ? 'PAGE_CALL_CANCELLED' : 'PAGE_CALL_FAILED', error: error instanceof Error ? error.message : 'Page call failed.' }
    } finally { active.delete(message.requestId) }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRequest(message) || message.kind !== 'handshake') return
    if (sender.id !== chrome.runtime.id) { respond({ ok: false, code: 'UNTRUSTED_SENDER', error: 'Handshake sender was rejected.' } satisfies ExtensionResponse); return }
    refreshGeneration()
    respond({ ok: true, data: { tabId: message.tabId, frameId: message.frameId, targetId: 'main-frame', documentId, revision, title: document.title, url: location.href } } satisfies ExtensionResponse)
  })
}
