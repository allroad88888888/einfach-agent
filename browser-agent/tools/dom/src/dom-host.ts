import { enqueueDocumentWrite } from '@einfach-agent/tools-browser-page'
import { clickElement, pressElement, scrollElement, typeElement } from './dom-actions'
import { toDomNode } from './dom-node'
import { readDom, type DomIdentity } from './dom-reader'
import { assertPage, assertNotAborted } from './page-binding'
import { waitForDom } from './waiter'
import type { DomActionResult, DomTargetInput, DomToolsHost, DomToolsHostOptions, PageCallContext, PageRef, PressDomKeyInput, ScrollDomInput, TypeDomInput } from './types'

export function createDomToolsHost(options: DomToolsHostOptions): DomToolsHost {
  const { document } = options
  const page: PageRef = { targetId: options.targetId, documentId: options.documentId ?? crypto.randomUUID(), revision: options.revision ?? 1 }
  const elementRefs = new WeakMap<Element, string>(); const observed = new Map<string, Element>(); let nextRef = 1
  const identity: DomIdentity = {
    idFor(element) { const existing = elementRefs.get(element); if (existing) return existing; const ref = `dom-${nextRef++}`; elementRefs.set(element, ref); observed.set(ref, element); return ref },
    resolve(ref) { return observed.get(ref) },
  }
  const resolveTarget = (input: DomTargetInput, ctx: PageCallContext): Element => {
    assertPage(document, page, input.page, ctx)
    const element = identity.resolve(input.ref)
    if (!element || !element.isConnected || element.ownerDocument !== document) throw new Error('DOM ref is unknown, removed, or was replaced')
    return element
  }
  const result = (ref: string, element?: Element): DomActionResult => ({ page: { ...page }, ref, dispatched: true, ...(element?.isConnected ? { node: toDomNode(element, ref, element.parentElement ? identity.idFor(element.parentElement) : undefined) } : {}) })
  const write = <T extends DomTargetInput>(input: T, ctx: PageCallContext, action: (element: Element, input: T, guard: (allowDetached?: boolean) => void) => void | true): Promise<DomActionResult> => enqueueDocumentWrite(document, async () => {
    const element = resolveTarget(input, ctx)
    const guard = (allowDetached = false): void => { assertPage(document, page, input.page, ctx); assertNotAborted(ctx); if (!allowDetached && (!element.isConnected || element.ownerDocument !== document || identity.resolve(input.ref) !== element)) throw new Error('DOM node was removed or replaced during action') }
    const allowDetached = action(element, input, guard) === true; guard(allowDetached); return result(input.ref, element)
  })
  return {
    async readDom(input, ctx) { assertPage(document, page, input.page, ctx); return readDom(document, page, identity, input) },
    clickDom(input, ctx) { return write(input, ctx, (element, _value, guard) => clickElement(element, guard)) },
    typeDom(input, ctx) { return write(input, ctx, (element, value, guard) => typeElement(element, value as TypeDomInput, guard)) },
    pressDomKey(input, ctx) { return write(input, ctx, (element, value, guard) => pressElement(element, value as PressDomKeyInput, guard)) },
    scrollDom(input, ctx) { return write(input, ctx, (element, value, guard) => scrollElement(element, value as ScrollDomInput, guard)) },
    waitForDom(input, ctx) { assertPage(document, page, input.page, ctx); return waitForDom(() => { assertPage(document, page, input.page, ctx); return readDom(document, page, identity, input) }, input, ctx) },
  }
}
