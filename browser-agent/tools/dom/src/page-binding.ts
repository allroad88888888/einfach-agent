import type { PageCallContext, PageRef } from './types'

export const abortError = (): DOMException => new DOMException('The operation was aborted', 'AbortError')
export const assertNotAborted = (ctx: PageCallContext): void => { if (ctx.signal.aborted) throw abortError() }
export const samePage = (left: PageRef, right: PageRef): boolean => left.targetId === right.targetId && left.documentId === right.documentId && left.revision === right.revision

export function isCurrentDocument(document: Document): boolean {
  return document.defaultView?.document === document
}

export function assertPage(document: Document, current: PageRef, requested: PageRef | undefined, ctx: PageCallContext): void {
  assertNotAborted(ctx)
  if (requested && !samePage(current, requested)) throw new Error('page reference is stale or belongs to another target')
  if (!isCurrentDocument(document)) throw new Error('document binding is no longer current')
}
