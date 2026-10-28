import { MAX_TYPE_TEXT } from './constants'
import { isDisabled, isDomVisible, isReadOnly } from './dom-visibility'
import type { PressDomKeyInput, ScrollDomInput, TypeDomInput } from './types'

export type ActionGuard = (allowDetached?: boolean) => void

export function assertActionable(element: Element): void {
  if (!isDomVisible(element)) throw new Error('DOM node is hidden or unavailable')
  if (isDisabled(element)) throw new Error('DOM node is disabled')
}

export function clickElement(element: Element, guard: ActionGuard): true {
  assertActionable(element)
  const view = element.ownerDocument.defaultView
  if (!view) throw new Error('document binding has no active window')
  const PointerEventConstructor = (view as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent
  const pointer = (name: string): Event => PointerEventConstructor
    ? new PointerEventConstructor(name, { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: 'mouse' })
    : new view.MouseEvent(name, { bubbles: true, cancelable: true, composed: true, button: 0 })
  element.dispatchEvent(pointer('pointerdown')); guard(); assertActionable(element)
  const focusAllowed = element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  guard(); assertActionable(element)
  if (focusAllowed && 'focus' in element && typeof (element as HTMLElement).focus === 'function') { (element as HTMLElement).focus(); guard(); assertActionable(element) }
  element.dispatchEvent(pointer('pointerup')); guard(); assertActionable(element)
  element.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, button: 0 })); guard(); assertActionable(element)
  if ('click' in element && typeof (element as HTMLElement).click === 'function') (element as HTMLElement).click()
  else element.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  guard(true)
  return true
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = element.ownerDocument.defaultView
  if (!view) throw new Error('document binding has no active window')
  const prototype = element.localName === 'textarea' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('DOM node does not expose a writable value')
  setter.call(element, value)
}

export function typeElement(element: Element, input: TypeDomInput, guard: ActionGuard): void {
  assertActionable(element)
  if (input.text.length > MAX_TYPE_TEXT) throw new Error(`text must be at most ${MAX_TYPE_TEXT} characters`)
  if (isReadOnly(element)) throw new Error('DOM node is read-only')
  if (element.localName === 'input') {
    const control = element as HTMLInputElement
    if (['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(control.type)) throw new Error('DOM node does not accept safe text input')
    setNativeValue(control, input.text)
  } else if (element.localName === 'textarea') setNativeValue(element as HTMLTextAreaElement, input.text)
  else if (element.getAttribute('contenteditable') === 'true') element.textContent = input.text
  else throw new Error('DOM node does not accept text input')
  const view = element.ownerDocument.defaultView
  if (!view) throw new Error('document binding has no active window')
  const InputEventConstructor = (view as unknown as { InputEvent?: typeof InputEvent }).InputEvent
  const inputEvent = InputEventConstructor ? new InputEventConstructor('input', { bubbles: true, composed: true, inputType: 'insertText', data: input.text }) : new view.Event('input', { bubbles: true, composed: true })
  element.dispatchEvent(inputEvent)
  guard(); assertActionable(element)
  element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }))
  guard()
}

export function pressElement(element: Element, input: PressDomKeyInput, guard: ActionGuard): void {
  assertActionable(element)
  if (!input.key || input.key.length > 50) throw new Error('key must contain 1 to 50 characters')
  const view = element.ownerDocument.defaultView
  if (!view) throw new Error('document binding has no active window')
  element.dispatchEvent(new view.KeyboardEvent('keydown', { key: input.key, bubbles: true, cancelable: true, composed: true }))
  guard(); assertActionable(element)
  element.dispatchEvent(new view.KeyboardEvent('keyup', { key: input.key, bubbles: true, cancelable: true, composed: true }))
  guard()
}

export function scrollElement(element: Element, input: ScrollDomInput, guard: ActionGuard): void {
  assertActionable(element)
  if (!['up', 'down', 'left', 'right'].includes(input.direction)) throw new Error('direction must be up, down, left, or right')
  const amount = input.amount ?? 300
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) throw new Error('amount must be greater than 0 and at most 10000')
  const x = input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0
  const y = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0
  if ('scrollBy' in element && typeof (element as HTMLElement).scrollBy === 'function') (element as HTMLElement).scrollBy({ left: x, top: y, behavior: 'auto' })
  else { (element as HTMLElement).scrollLeft += x; (element as HTMLElement).scrollTop += y; element.dispatchEvent(new (element.ownerDocument.defaultView?.Event ?? Event)('scroll')) }
  guard()
}
