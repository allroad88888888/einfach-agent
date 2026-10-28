import type { ControlledFieldAdapter, FieldValue, FormField } from './types'
import { fieldLabel, fieldRequired } from './dom-field-labels'
import { isLogicalControl, logicalControlSelector } from './dom-control-roots'
import { describeExposedOptions, describeLogicalControl } from './dom-logical-controls'
export type NativeField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
export interface ResolvedField { element: Element; adapter?: ControlledFieldAdapter }
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
  const result: Omit<FormField, 'id'> = { label: fieldLabel(element), kind: supported ? nativeKind(element) : `input-${isInput(element) ? element.type : 'unknown'}`, value: nativeValue(element), required: element.required || fieldRequired(element), readOnly: element.disabled || ('readOnly' in element && element.readOnly), supported }
  if (isSelect(element)) { result.options = Array.from(element.options, ({ text, value, disabled }) => ({ label: text.trim(), value, ...(disabled ? { disabled: true } : {}) })); result.optionsStatus = 'exposed' }
  if (isInput(element) && element.list) { result.options = Array.from(element.list.options, ({ label, value }) => ({ label: label.trim() || value, value })); result.optionsStatus = 'exposed' }
  if (element.getAttribute('role') === 'combobox' || ['listbox', 'tree'].includes(element.getAttribute('aria-haspopup') ?? '')) {
    const semantic = describeExposedOptions(element)
    if (semantic.optionsStatus === 'exposed' || result.optionsStatus === undefined) Object.assign(result, semantic)
  }
  return result
}
export function candidateElements(doc: Document, adapters: readonly ControlledFieldAdapter[]): ResolvedField[] {
  const all = Array.from(doc.querySelectorAll('*')).filter((element) => !isSensitive(element))
  const controlled = new Map<Element, ControlledFieldAdapter>()
  for (const adapter of adapters) for (const element of all) if (!controlled.has(element) && adapter.matches(element)) controlled.set(element, adapter)
  const adapted = Array.from(controlled.keys()).filter((element, _index, matches) => !matches.some((other) => other !== element && other.contains(element)))
  const overlapsAdapter = (element: Element): boolean => adapted.some((item) => item === element || item.contains(element) || element.contains(item))
  const complexRoots = Array.from(doc.querySelectorAll(logicalControlSelector)).filter((element) => !overlapsAdapter(element) && isLogicalControl(element))
  const owned = new Set(complexRoots.flatMap((element) => `${element.getAttribute('aria-controls') ?? ''} ${element.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean)))
  const logicalRoots = complexRoots.filter((element) => !complexRoots.some((other) => other !== element && other.contains(element)))
    .filter((element) => !element.id || !owned.has(element.id))
  return all.flatMap((element): ResolvedField[] => {
    const adapter = adapted.includes(element) ? controlled.get(element) : undefined
    if (adapter) return [{ element, adapter }]
    if (overlapsAdapter(element)) return []
    if (logicalRoots.includes(element)) return [{ element }]
    if (isNativeField(element) && !logicalRoots.some((root) => root.contains(element))) return [{ element }]
    return []
  })
}
export function readResolved(field: ResolvedField, id: string): FormField {
  if (field.adapter) { const value = field.adapter.read(field.element); return { id, kind: field.adapter.kind, ...value, readOnly: value.readOnly || nativeReadOnly(field.element) } }
  if (isNativeField(field.element)) return { id, ...describeNative(field.element) }
  return { id, ...describeLogicalControl(field.element) }
}
