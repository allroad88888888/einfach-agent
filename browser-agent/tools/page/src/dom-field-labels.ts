import { isLogicalControl, logicalControlSelector, richTextBody } from './dom-control-roots'

const clean = (value: string | null | undefined): string => (value ?? '')
  .replace(/\s+/g, ' ')
  .replace(/\s*[：:]\s*$/, '')
  .replace(/^\s*[＊*]\s*/, '')
  .replace(/\s*[＊*]\s*$/, '')
  .trim()

const hiddenSelf = (element: Element): boolean => {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element as HTMLElement)
  return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
    || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
}

const visible = (element: Element): boolean => {
  for (let item: Element | null = element; item; item = item.parentElement) if (hiddenSelf(item)) return false
  return true
}

const labelledBy = (element: Element): string => {
  const ids = clean(element.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean)
  return clean(ids.map((id) => {
    const label = element.ownerDocument.getElementById(id)
    return label?.textContent ?? ''
  }).join(' '))
}

const associatedLabel = (element: Element): string => {
  const doc = element.ownerDocument
  const explicit = element.id
    ? Array.from(doc.querySelectorAll('label')).filter((label) => label.htmlFor === element.id)
    : []
  const labels = explicit.length ? explicit : element.closest('label') ? [element.closest('label')!] : []
  return clean(labels.filter(visible).map((label) => label.textContent).join(' '))
}

const FIELD_SELECTOR = `input:not([type="hidden"]):not([type="password"]),textarea,select,${logicalControlSelector}`
const isFormItem = (element: Element): boolean => {
  const classes = Array.from(element.classList)
  return element.getAttribute('role') === 'group' || classes.some((name) => /(?:^|[-_])form-item$/.test(name))
}

const fieldRoots = (container: Element): Element[] => {
  const fields = Array.from(container.querySelectorAll(FIELD_SELECTOR)).filter((element) =>
    ['input', 'textarea', 'select'].includes(element.localName) || isLogicalControl(element))
  return fields.filter((candidate) => !fields.some((other) => other !== candidate && other.contains(candidate)))
}

const nearbyFormItem = (element: Element): Element | undefined => {
  for (let item = element.parentElement; item && item.localName !== 'form' && item.localName !== 'body'; item = item.parentElement) {
    if (item.querySelector('form')) continue
    const hasExternalLabel = Array.from(item.querySelectorAll('label')).some((label) => visible(label) && !element.contains(label))
    if (!isFormItem(item) && !hasExternalLabel) continue
    const roots = fieldRoots(item)
    if (roots.length === 1 && (roots[0] === element || roots[0].contains(element) || element.contains(roots[0]))) return item
    return undefined
  }
}

const classLikeRequired = (element: Element): boolean => Array.from(element.classList).some((name) => /(?:^|[-_])required(?:$|[-_])/.test(name))

export const fieldRequired = (element: Element): boolean => {
  if (element.getAttribute('aria-required') === 'true' || element.hasAttribute('required')) return true
  const item = nearbyFormItem(element)
  if (!item) return false
  const controlBranch = Array.from(item.children).find((child) => child === element || child.contains(element))
  return Array.from(item.querySelectorAll('label, label *, [class*="required"]')).some((candidate) =>
    visible(candidate) && !(controlBranch && controlBranch.contains(candidate))
      && (candidate.getAttribute('aria-required') === 'true' || classLikeRequired(candidate)))
}

const nearbyTitle = (element: Element): string => {
  const item = nearbyFormItem(element)
  if (!item) return ''
  const controlBranch = Array.from(item.children).find((child) => child === element || child.contains(element))
  const candidates = Array.from(item.querySelectorAll('label, span[title], label [title]'))
    .filter((candidate) => visible(candidate) && !(controlBranch && controlBranch.contains(candidate)))
    .filter((candidate) => !candidate.closest('[role="alert"], [role="status"], option'))
  const titled = Array.from(new Set(candidates.map((candidate) => clean(candidate.getAttribute('title'))).filter(Boolean)))
  if (titled.length === 1) return titled[0]
  if (titled.length > 1) return ''
  const values = Array.from(new Set(candidates.map((candidate) => clean(candidate.textContent)).filter(Boolean)))
  return values.length === 1 ? values[0] : ''
}

export function fieldLabel(element: Element): string {
  const aria = clean(element.getAttribute('aria-label'))
  if (aria) return aria
  const referenced = labelledBy(element)
  if (referenced) return referenced
  const label = associatedLabel(element)
  if (label) return label
  const nearby = nearbyTitle(element)
  if (richTextBody(element) && nearby) return nearby
  const title = clean(element.getAttribute('title'))
  if (title) return title
  return nearby || clean(element.getAttribute('name')) || clean(element.getAttribute('placeholder'))
}
