import { MAX_TEXT } from './constants'
import { isDisabled, isReadOnly } from './dom-visibility'
import type { DomNode } from './types'

const safeAttributes = ['id', 'title', 'placeholder', 'type', 'for', 'aria-controls', 'aria-haspopup', 'aria-current']
const compact = (value: string | null | undefined): string | undefined => {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, MAX_TEXT) : undefined
}

function labelText(element: Element): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
    if (compact(text)) return compact(text)
  }
  if (['input', 'select', 'textarea'].includes(element.localName)) {
    const labels = Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent ?? '').join(' ')
    if (compact(labels)) return compact(labels)
  }
  return undefined
}

function safeValue(element: Element): string | undefined {
  if (element.localName === 'input') { const input = element as HTMLInputElement; return input.type === 'password' || input.type === 'hidden' ? undefined : compact(input.value) }
  if (element.localName === 'textarea' || element.localName === 'select') return compact((element as HTMLTextAreaElement).value)
  if (element.getAttribute('contenteditable') === 'true') return compact(element.textContent)
  return undefined
}

export function toDomNode(element: Element, ref: string, parentRef?: string): DomNode {
  const text = compact(element.childElementCount ? Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? '').join(' ') : element.textContent)
  const name = compact(element.getAttribute('aria-label')) ?? labelText(element) ?? compact(element.getAttribute('title')) ?? compact(element.getAttribute('placeholder')) ?? compact(element.getAttribute('alt')) ?? text ?? ''
  const attributes = Object.fromEntries(safeAttributes.flatMap((key) => { const value = element.getAttribute(key); return value === null ? [] : [[key, value.slice(0, MAX_TEXT)]] }))
  const node: DomNode = { ref, tag: element.tagName.toLowerCase(), name }
  if (parentRef) node.parentRef = parentRef
  const role = compact(element.getAttribute('role')); if (role) node.role = role
  if (text) node.text = text
  const value = safeValue(element); if (value !== undefined) node.value = value
  if (isDisabled(element)) node.disabled = true
  if (isReadOnly(element)) node.readOnly = true
  const booleanAttrs = [['aria-expanded', 'expanded'], ['aria-selected', 'selected'], ['aria-checked', 'checked']] as const
  for (const [attribute, property] of booleanAttrs) { const raw = element.getAttribute(attribute); if (raw === 'true' || raw === 'false') node[property] = raw === 'true' }
  if (element.localName === 'input' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)) node.checked = (element as HTMLInputElement).checked
  if (Object.keys(attributes).length) node.attributes = attributes
  return node
}
