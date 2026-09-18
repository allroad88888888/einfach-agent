import type { FieldOutcome, FieldValue, FormSnapshot, PageCallContext, PageRef, PageToolsHost } from '@einfach-agent/tools-browser-page'
import { CHANNEL, pageRef, type ExtensionResponse, type PageMethod, type TargetBinding } from './protocol'

export class ExtensionPageBridge implements PageToolsHost {
  private readonly bindings = new Map<string, TargetBinding>()
  bind(sessionId: string, target: TargetBinding): void { this.bindings.set(sessionId, target); void this.persist() }
  unbind(sessionId: string): void { this.bindings.delete(sessionId); void this.persist() }
  target(sessionId: string): TargetBinding | undefined { return this.bindings.get(sessionId) }
  async restore(sessionIds: readonly string[]): Promise<void> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    for (const sessionId of sessionIds) {
      const target = (stored as Record<string, unknown>)[sessionId]
      if (!isTarget(target)) continue
      try {
        const response = await chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'handshake', tabId: target.tabId, frameId: target.frameId }) as ExtensionResponse
        if (response.ok && isTarget(response.data) && response.data.documentId === target.documentId) this.bindings.set(sessionId, target)
      } catch { /* A closed tab or navigated document remains deliberately unbound. */ }
    }
    await this.persist()
  }

  async readForm(ctx: PageCallContext): Promise<FormSnapshot> {
    return this.call('readForm', undefined, ctx) as Promise<FormSnapshot>
  }
  async fillFields(input: { page: PageRef; values: readonly { id: string; value: FieldValue }[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('fillFields', input, ctx) as Promise<readonly FieldOutcome[]>
  }
  async validateForm(input: { page: PageRef; fieldIds?: readonly string[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('validateForm', input, ctx) as Promise<readonly FieldOutcome[]>
  }

  private assertPage(page: PageRef, sessionId: string): void {
    const target = this.requireTarget(sessionId)
    const expected = pageRef(target)
    if (page.targetId !== expected.targetId || page.documentId !== expected.documentId || page.revision !== expected.revision) throw new Error('The page reference is stale or belongs to another session.')
  }
  private requireTarget(sessionId: string): TargetBinding {
    const target = this.bindings.get(sessionId)
    if (!target) throw new Error('This session is not bound to a page. Bind a target before running it.')
    return target
  }
  private async call(method: PageMethod, input: unknown, ctx: PageCallContext): Promise<FormSnapshot | readonly FieldOutcome[]> {
    const target = this.requireTarget(ctx.sessionId)
    if (ctx.signal.aborted) throw abortError()
    const requestId = crypto.randomUUID()
    let settled = false
    const cancel = () => {
      if (!settled) void chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'cancel-page-call', requestId, target })
    }
    ctx.signal.addEventListener('abort', cancel, { once: true })
    try {
      const response = await chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'page-call', requestId, target, sessionId: ctx.sessionId, method, input }) as ExtensionResponse
      settled = true
      if (ctx.signal.aborted) throw abortError()
      if (!response?.ok) throw new Error(response?.unknownResult ? `${response.error} The write result is unknown and will not be replayed.` : response?.error ?? 'Page call failed.')
      return response.data as FormSnapshot | readonly FieldOutcome[]
    } finally { ctx.signal.removeEventListener('abort', cancel) }
  }
  private persist(): Promise<void> { return chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(this.bindings) }) }
}

function abortError(): DOMException { return new DOMException('The page call was cancelled.', 'AbortError') }

const STORAGE_KEY = 'einfach-browser-agent-bindings-v1'
function isTarget(value: unknown): value is TargetBinding {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TargetBinding>
  return Number.isInteger(item.tabId) && Number.isInteger(item.frameId) && typeof item.targetId === 'string' && typeof item.documentId === 'string' && Number.isInteger(item.revision) && typeof item.url === 'string' && typeof item.title === 'string'
}

export async function bindActiveTab(): Promise<TargetBinding> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url) throw new Error('No active page is available.')
  const url = new URL(tab.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('This browser page is restricted and cannot be bound.')
  const originPattern = `${url.origin}/*`
  const allowed = await chrome.permissions.contains({ origins: [originPattern] }) || await chrome.permissions.request({ origins: [originPattern] })
  if (!allowed) throw new Error(`Permission was denied for ${url.origin}.`)
  const response = await chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'handshake', tabId: tab.id, frameId: 0 }) as ExtensionResponse
  if (!response?.ok) throw new Error(response?.error ?? 'The content script did not connect.')
  if (!isTarget(response.data)) throw new Error('The content script returned an invalid target.')
  return response.data
}
