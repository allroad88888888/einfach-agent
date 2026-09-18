import type { ControlledFieldAdapter, FieldValue, FormField } from './types'
export type NativeField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
export interface ResolvedField { element: Element; adapter?: ControlledFieldAdapter }
const text = (value: string | null | undefined): string => value?.trim() ?? ''
const STRING_INPUT_TYPES = new Set(['text', 'email', 'url', 'tel', 'search', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const htmlTag = (element: Element, tag: string): boolean => element.namespaceURI === HTML_NAMESPACE && element.localName === tag
export const isInput = (element: Element): element is HTMLInputElement => htmlTag(element, 'input')
export const isTextArea = (element: Element): element is HTMLTextAreaElement => htmlTag(element, 'textarea')
export const isSelect = (element: Element): element is HTMLSelectElement => htmlTag(element, 'select')
export const isNativeField = (element: Element): element is NativeField => isInput(element) || isTextArea(element) || isSelect(element)
export const nativeSupported = (element: NativeField): boolean => !isInput(element) || STRING_INPUT_TYPES.has(element.type) || element.type === 'checkbox' || element.type === 'radio'
export const nativeReadOnly = (element: Element): boolean => {
  if (!isNativeField(element)) return false
  return element.disabled || ('readOnly' in element && element.readOnly)
}
const isSensitive = (element: Element): boolean => isInput(element) && (element.type === 'hidden' || element.type === 'password')
export function fieldLabel(element: Element): string {
  const doc = element.ownerDocument
  const aria = text(element.getAttribute('aria-label')); if (aria) return aria
  const labelledBy = text(element.getAttribute('aria-labelledby'))
  if (labelledBy) { const label = labelledBy.split(/\s+/).map((id) => text(doc.getElementById(id)?.textContent)).filter(Boolean).join(' '); if (label) return label }
  const explicit = element.id ? Array.from(doc.querySelectorAll('label')).find((label) => label.htmlFor === element.id) ?? null : null
  const label = text((explicit ?? element.closest('label'))?.textContent); if (label) return label
  return text(element.getAttribute('name')) || text(element.getAttribute('placeholder'))
}
export function nativeKind(element: NativeField): string {
  if (isTextArea(element)) return 'textarea'
  if (isSelect(element)) return element.multiple ? 'select-multiple' : 'select'
  return element.type === 'checkbox' || element.type === 'radio' ? element.type : 'text'
}
export function nativeValue(element: NativeField): FieldValue {
  if (isInput(element) && (element.type === 'checkbox' || element.type === 'radio')) return element.checked
  if (isSelect(element) && element.multiple) return Array.from(element.selectedOptions, (option) => option.value)
  return element.value
}
export function describeNative(element: NativeField): Omit<FormField, 'id'> {
  const supported = nativeSupported(element)
  const result: Omit<FormField, 'id'> = { label: fieldLabel(element), kind: supported ? nativeKind(element) : `input-${isInput(element) ? element.type : 'unknown'}`, value: nativeValue(element), required: element.required, readOnly: element.disabled || ('readOnly' in element && element.readOnly), supported }
  if (isSelect(element)) result.options = Array.from(element.options, ({ text, value }) => ({ label: text.trim(), value }))
  return result
}
export function candidateElements(doc: Document, adapters: readonly ControlledFieldAdapter[]): ResolvedField[] {
  const all = Array.from(doc.querySelectorAll('*')).filter((element) => !isSensitive(element))
  const controlled = adapters.flatMap((adapter) => all.filter((element) => adapter.matches(element)).map((element) => ({ element, adapter })))
  const adapted = new Set(controlled.map(({ element }) => element))
  const native = all.filter((element): element is NativeField => !adapted.has(element) && isNativeField(element)).map((element) => ({ element }))
  const complex = Array.from(doc.querySelectorAll('[contenteditable="true"], [role="combobox"]')).map((element) => ({ element }))
  const seen = new Set<Element>()
  const candidates = [...controlled, ...native, ...complex].filter(({ element }) => !isSensitive(element))
  return candidates.filter(({ element }) => !seen.has(element) && Boolean(seen.add(element)))
}
export function readResolved(field: ResolvedField, id: string): FormField {
  if (field.adapter) { const value = field.adapter.read(field.element); return { id, kind: field.adapter.kind, ...value, readOnly: value.readOnly || nativeReadOnly(field.element) } }
  if (isNativeField(field.element)) return { id, ...describeNative(field.element) }
  return { id, label: fieldLabel(field.element), kind: field.element.getAttribute('role') ?? 'contenteditable', value: '', required: false, readOnly: true, supported: false }
}
