import type { FieldOutcome, FieldValue, FormSnapshot, PageCallContext, PageReadInput, PageRef, PageSnapshot, PageToolsHost, ReadTableInput, TableSnapshot } from '@einfach-agent/tools-browser-page'
import type { DomActionResult, DomSnapshot, DomTargetInput, DomToolsHost, PressDomKeyInput, ReadDomInput, ScrollDomInput, TypeDomInput, WaitForDomInput } from '@einfach-agent/tools-browser-dom'
import { PageBindings } from './page-bindings'
export { bindActiveTab } from './tab-targets'
import { CHANNEL, pageRef, type DomMethod, type ExtensionResponse, type PageMethod, type TargetBinding } from './protocol'

export class ExtensionPageBridge extends PageBindings implements PageToolsHost, DomToolsHost {

  async readForm(ctx: PageCallContext): Promise<FormSnapshot> {
    return this.call('readForm', undefined, ctx) as Promise<FormSnapshot>
  }
  async readPage(input: PageReadInput, ctx: PageCallContext): Promise<PageSnapshot> {
    return this.call('readPage', input, ctx) as Promise<PageSnapshot>
  }
  async readTable(input: ReadTableInput, ctx: PageCallContext): Promise<TableSnapshot> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('readTable', input, ctx) as Promise<TableSnapshot>
  }
  async fillFields(input: { page: PageRef; values: readonly { id: string; value: FieldValue }[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('fillFields', input, ctx) as Promise<readonly FieldOutcome[]>
  }
  async validateForm(input: { page: PageRef; fieldIds?: readonly string[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('validateForm', input, ctx) as Promise<readonly FieldOutcome[]>
  }
  async readDom(input: ReadDomInput, ctx: PageCallContext): Promise<DomSnapshot> {
    if (input.page) this.assertPage(input.page, ctx.sessionId)
    return this.call('readDom', input, ctx) as Promise<DomSnapshot>
  }
  async clickDom(input: DomTargetInput, ctx: PageCallContext): Promise<DomActionResult> { return this.domAction('clickDom', input, ctx) }
  async typeDom(input: TypeDomInput, ctx: PageCallContext): Promise<DomActionResult> { return this.domAction('typeDom', input, ctx) }
  async pressDomKey(input: PressDomKeyInput, ctx: PageCallContext): Promise<DomActionResult> { return this.domAction('pressDomKey', input, ctx) }
  async scrollDom(input: ScrollDomInput, ctx: PageCallContext): Promise<DomActionResult> { return this.domAction('scrollDom', input, ctx) }
  async waitForDom(input: WaitForDomInput, ctx: PageCallContext): Promise<DomSnapshot> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call('waitForDom', input, ctx) as Promise<DomSnapshot>
  }
  private domAction(method: Exclude<DomMethod, 'readDom' | 'waitForDom'>, input: DomTargetInput, ctx: PageCallContext): Promise<DomActionResult> {
    this.assertPage(input.page, ctx.sessionId)
    return this.call(method, input, ctx) as Promise<DomActionResult>
  }

  private assertPage(page: PageRef, sessionId: string): void {
    const target = this.requireTarget(sessionId)
    const expected = pageRef(target)
    if (page.targetId !== expected.targetId || page.documentId !== expected.documentId || page.revision !== expected.revision) throw new Error('The page reference is stale or belongs to another session.')
  }
  private requireTarget(sessionId: string): TargetBinding {
    const target = this.target(sessionId)
    if (!target) throw new Error('This session is not bound to a page. Bind a target before running it.')
    return target
  }
  private async call(method: PageMethod | DomMethod, input: unknown, ctx: PageCallContext): Promise<import('./protocol').PageResult> {
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
      if (!response?.ok && (response?.code === 'STALE_DOCUMENT' || response?.code === 'PAGE_URL_CHANGED')) this.invalidate(ctx.sessionId, 'changed', '目标页面已变化，请重新绑定后继续。')
      if (!response?.ok) throw new Error(response?.unknownResult ? `${response.error} The write result is unknown and will not be replayed.` : response?.error ?? 'Page call failed.')
      return response.data as import('./protocol').PageResult
    } finally { ctx.signal.removeEventListener('abort', cancel) }
  }
}

function abortError(): DOMException { return new DOMException('The page call was cancelled.', 'AbortError') }
