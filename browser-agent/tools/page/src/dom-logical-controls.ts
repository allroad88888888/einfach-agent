import { fieldLabel, fieldRequired } from './dom-field-labels'
import { hasClassFragment, isCustomFormControl, richTextBody } from './dom-control-roots'
import type { FieldOption, FieldValue, FormField } from './types'

const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
const hiddenSelf = (element: Element): boolean => {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element as HTMLElement)
  return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
    || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
}
const hiddenInTree = (element: Element): boolean => {
  for (let item: Element | null = element; item; item = item.parentElement) if (hiddenSelf(item)) return true
  return false
}
const excluded = (element: Element): boolean => ['script', 'style', 'input', 'textarea', 'select', 'option'].includes(element.localName)
const safeText = (element: Element): string => {
  if (hiddenInTree(element)) return ''
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const parts: string[] = []
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement
    if (!parent || Array.from(generateSelfAndParents(parent, element)).some((item) => hiddenSelf(item) || excluded(item))) continue
    parts.push(walker.currentNode.textContent ?? '')
  }
  return clean(parts.join(' '))
}
function* generateSelfAndParents(element: Element, root: Element): Generator<Element> {
  for (let item: Element | null = element; item; item = item === root ? null : item.parentElement) yield item
}
const placeholderNode = (element: Element, root: Element): boolean => element !== root
  && (hasClassFragment(element, 'placeholder') || element.hasAttribute('data-placeholder') || element.hasAttribute('aria-placeholder'))
const currentText = (element: Element): string => {
  if (hiddenInTree(element)) return ''
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const parts: string[] = []
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement
    if (!parent || Array.from(generateSelfAndParents(parent, element)).some((item) => {
      const role = item.getAttribute('role')
      return hiddenSelf(item) || excluded(item) || placeholderNode(item, element)
        || role === 'listbox' || role === 'tree' || role === 'option' || role === 'treeitem'
    })) continue
    parts.push(walker.currentNode.textContent ?? '')
  }
  const value = clean(parts.join(' '))
  const hint = clean(element.getAttribute('aria-placeholder') || element.getAttribute('data-placeholder'))
  return hint && value === hint ? '' : value
}

const linkedPopup = (element: Element): Element | undefined => {
  const ids = clean(`${element.getAttribute('aria-controls') ?? ''} ${element.getAttribute('aria-owns') ?? ''}`).split(' ').filter(Boolean)
  return ids.map((id) => element.ownerDocument.getElementById(id)).find((item): item is HTMLElement => Boolean(item && !hiddenInTree(item) && ['listbox', 'tree'].includes(item.getAttribute('role') ?? '')))
}

const optionValue = (element: Element): string | undefined => element.getAttribute('data-value') ?? element.getAttribute('value') ?? undefined

export const describeExposedOptions = (element: Element): { options?: readonly FieldOption[]; optionLabels?: readonly string[]; optionsStatus: 'exposed' | 'not-exposed' } => {
  const popup = linkedPopup(element) ?? (['listbox', 'tree'].includes(element.getAttribute('role') ?? '') ? element : undefined)
  if (!popup) return { optionsStatus: 'not-exposed' }
  const found = Array.from(popup.querySelectorAll('[role="option"], [role="treeitem"]')).map((option) => ({
    label: safeText(option),
    ...(optionValue(option) !== undefined ? { value: optionValue(option) } : {}),
    ...(option.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
  })).filter(({ label }) => Boolean(label))
  return found.every((option) => option.value !== undefined)
    ? { options: found as FieldOption[], optionsStatus: 'exposed' }
    : { optionLabels: found.map(({ label }) => label), optionsStatus: 'exposed' }
}

const selectedValues = (element: Element, multiple: boolean): FieldValue => {
  const popup = linkedPopup(element) ?? element
  const selected = Array.from(popup.querySelectorAll('[aria-selected="true"], [aria-checked="true"]'))
    .filter((item) => !hiddenInTree(item))
    .map((item) => optionValue(item) ?? safeText(item)).filter(Boolean)
  if (selected.length) return multiple ? selected : selected[0]
  if (['listbox', 'tree'].includes(element.getAttribute('role') ?? '')) return multiple ? [] : ''
  if (multiple) return Array.from(element.children).filter((item) => !placeholderNode(item, element)).map((item) => currentText(item)).filter(Boolean)
  const valueText = clean(element.getAttribute('aria-valuetext'))
  if (valueText) return valueText
  return currentText(element)
}

const isMultiple = (element: Element): boolean => element.getAttribute('aria-multiselectable') === 'true'
  || hasClassFragment(element, 'multiple') || Boolean(element.querySelector('[class*="multiple" i]'))

export function describeLogicalControl(element: Element): Omit<FormField, 'id'> {
  const editor = richTextBody(element)
  const multiple = isMultiple(element)
  const optionControl = isCustomFormControl(element) || ['combobox', 'listbox'].includes(element.getAttribute('role') ?? '')
    || ['listbox', 'tree'].includes(element.getAttribute('aria-haspopup') ?? '')
  const exposed = optionControl ? describeExposedOptions(element) : undefined
  const disabled = element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled')
  const readOnly = disabled || element.getAttribute('aria-readonly') === 'true' || element.hasAttribute('readonly')
  const role = element.getAttribute('role')
  const kind = editor ? 'richtext' : role ? (multiple ? `${role}-multiple` : role)
    : isCustomFormControl(element) ? (multiple ? 'custom-multiple' : 'custom-select')
      : element.getAttribute('contenteditable') === 'true' ? 'contenteditable' : 'popup-trigger'
  return {
    label: fieldLabel(element), kind,
    value: editor ? safeText(editor) : selectedValues(element, multiple),
    required: fieldRequired(element), readOnly, supported: false,
    ...(exposed ?? {}),
  }
}
