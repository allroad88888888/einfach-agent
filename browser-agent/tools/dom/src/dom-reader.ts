import { DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET, MAX_QUERY, MAX_SCAN } from './constants'
import { toDomNode } from './dom-node'
import { isDomVisible } from './dom-visibility'
import type { DomNode, DomSnapshot, ReadDomInput } from './types'

export interface DomIdentity {
  idFor(element: Element): string
  resolve(ref: string): Element | undefined
}

const boundedInteger = (value: number | undefined, fallback: number, maximum: number, name: string): number => {
  const actual = value ?? fallback
  if (!Number.isInteger(actual) || actual < 0 || actual > maximum) throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  return actual
}

function candidate(element: Element): boolean {
  if (!isDomVisible(element)) return false
  if (element.localName === 'input' && (['password', 'hidden'].includes((element as HTMLInputElement).type))) return false
  return Boolean(element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(element.tagName))
}

export function readDom(document: Document, page: DomSnapshot['page'], identity: DomIdentity, input: ReadDomInput): DomSnapshot {
  const offset = boundedInteger(input.offset, 0, MAX_OFFSET, 'offset')
  const limit = boundedInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit')
  if (limit < 1) throw new Error('limit must be at least 1')
  if (input.selector && input.selector.length > MAX_QUERY) throw new Error(`selector must be at most ${MAX_QUERY} characters`)
  if (input.text && input.text.length > MAX_QUERY) throw new Error(`text must be at most ${MAX_QUERY} characters`)
  const scope = input.scopeRef ? identity.resolve(input.scopeRef) : document.documentElement
  if (!scope || !scope.isConnected || scope.ownerDocument !== document) throw new Error('scope ref is unknown, removed, or was replaced')
  let elements: Element[]
  try { elements = input.selector ? Array.from(scope.querySelectorAll(input.selector)) : [scope, ...Array.from(scope.querySelectorAll('*'))] }
  catch (error) { throw new Error(`invalid selector: ${error instanceof Error ? error.message : String(error)}`) }
  const nodes: DomNode[] = []; let matches = 0; let scanned = 0; let hasMore = false
  const needle = input.text?.toLocaleLowerCase()
  for (const element of elements) {
    if (++scanned > MAX_SCAN) throw new Error(`DOM scan exceeded the ${MAX_SCAN} node safety limit; narrow the query with selector or scopeRef`)
    if (!candidate(element)) continue
    const ref = identity.idFor(element); const parent = element.parentElement; const parentRef = parent ? identity.idFor(parent) : undefined
    const node = toDomNode(element, ref, parentRef)
    if (needle && !`${node.name} ${node.text ?? ''} ${node.value ?? ''}`.toLocaleLowerCase().includes(needle)) continue
    if (matches++ < offset) continue
    if (nodes.length < limit) nodes.push(node); else { hasMore = true; break }
  }
  const nextOffset = hasMore ? offset + nodes.length : undefined
  return { page: { ...page }, nodes, truncated: hasMore, ...(nextOffset === undefined ? {} : { nextOffset }) }
}
