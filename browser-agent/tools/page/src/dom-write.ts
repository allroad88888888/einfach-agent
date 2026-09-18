import type { FieldValue, PageCallContext } from './types'
import { isInput, isNativeField, isSelect, nativeReadOnly, nativeSupported, type NativeField, type ResolvedField } from './dom-fields'
const dispatch = (element: Element, type: string): boolean => {
  const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event
  return element.dispatchEvent(new EventConstructor(type, { bubbles: true, composed: true }))
}
export function assertWritable(field: ResolvedField): string | undefined {
  if (!(field.element as Node).isConnected) return 'field was replaced or removed'
  if (nativeReadOnly(field.element)) return 'field is disabled or read-only'
  if (field.adapter) return field.adapter.read(field.element).readOnly ? 'field is disabled or read-only' : undefined
  if (!isNativeField(field.element)) return 'field type is unsupported'
  const element = field.element as NativeField
  if (!nativeSupported(element)) return 'field type is unsupported'
  return element.disabled || ('readOnly' in element && element.readOnly) ? 'field is disabled or read-only' : undefined
}
export async function writeResolved(field: ResolvedField, value: FieldValue, ctx: PageCallContext): Promise<string | undefined> {
  const blocked = assertWritable(field); if (blocked) return blocked
  if (field.adapter) { await field.adapter.write(field.element, value, ctx); return undefined }
  const element = field.element as NativeField
  if (isInput(element) && (element.type === 'checkbox' || element.type === 'radio')) {
    if (typeof value !== 'boolean') return `${element.type} requires a boolean value`
    element.checked = value; dispatch(element, 'input'); dispatch(element, 'change'); return undefined
  }
  if (isSelect(element) && element.multiple) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return 'multi-select requires an array of strings'
    const allowed = new Set(Array.from(element.options, (option) => option.value)); if (value.some((item) => !allowed.has(item))) return 'value is not an available option'
    for (const option of element.options) option.selected = value.includes(option.value)
    dispatch(element, 'input'); dispatch(element, 'change'); return undefined
  }
  if (typeof value !== 'string') return 'field requires a string value'
  if (isSelect(element) && !Array.from(element.options).some((option) => option.value === value)) return 'value is not an available option'
  element.value = value; dispatch(element, 'input'); dispatch(element, 'change'); return undefined
}
