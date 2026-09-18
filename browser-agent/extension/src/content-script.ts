import { createDomPageHost } from '@einfach-agent/tools-browser-page'
import { CHANNEL, isRecord, isRequest, type ExtensionResponse, type PageRequest } from './protocol'

const marker = '__einfachBrowserAgentContentInstalled__'
const scope = globalThis as typeof globalThis & Record<string, unknown>
if (!scope[marker]) {
  scope[marker] = true
  const documentId = crypto.randomUUID()
  const revision = 1
  const host = createDomPageHost({ document, targetId: 'main-frame', documentId, revision })
  const active = new Map<string, AbortController>()

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRequest(message) || message.kind === 'handshake') return
    if (sender.id !== chrome.runtime.id) { respond({ ok: false, code: 'UNTRUSTED_SENDER', error: 'Page request sender was rejected.' } satisfies ExtensionResponse); return }
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
        : message.method === 'fillFields' && isRecord(message.input) && Array.isArray(message.input.values)
          ? await host.fillFields({ page: message.input.page as never, values: message.input.values as never }, ctx)
          : message.method === 'validateForm' && isRecord(message.input)
            ? await host.validateForm({ page: message.input.page as never, fieldIds: Array.isArray(message.input.fieldIds) ? message.input.fieldIds as string[] : undefined }, ctx)
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
    respond({ ok: true, data: { tabId: message.tabId, frameId: message.frameId, targetId: 'main-frame', documentId, revision, title: document.title, url: location.href } } satisfies ExtensionResponse)
  })
}
