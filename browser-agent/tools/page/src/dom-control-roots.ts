const classLike = (element: Element, fragment: string): boolean =>
  Array.from(element.classList).some((name) => name.toLowerCase().includes(fragment.toLowerCase()))

const hidden = (element: Element): boolean => {
  for (let item: Element | null = element; item; item = item.parentElement) {
    const style = item.ownerDocument.defaultView?.getComputedStyle(item as HTMLElement)
    if (item.hasAttribute('hidden') || item.getAttribute('aria-hidden') === 'true'
      || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true
  }
  return false
}

const customFormControl = (element: Element): boolean => {
  if (!['div', 'span'].includes(element.localName) || !element.hasAttribute('tabindex')) return false
  if (Number(element.getAttribute('tabindex')) < 0 || element.hasAttribute('role') || element.closest('nav')) return false
  if (element.querySelector('input:not([type="hidden"]):not([type="password"]), textarea, select, button, a[href]')) return false
  const labelled = Boolean(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'))
  const item = Array.from(generateParents(element)).find((parent) =>
    Array.from(parent.querySelectorAll('label')).some((label) => !element.contains(label)))
  if (!labelled && !item) return false
  const focusable = item ? Array.from(item.querySelectorAll('[tabindex]')).filter((candidate) =>
    Number(candidate.getAttribute('tabindex')) >= 0 && ['div', 'span'].includes(candidate.localName)
      && !candidate.querySelector('input:not([type="hidden"]):not([type="password"]), textarea, select, button, a[href]')) : [element]
  const placeholder = element.hasAttribute('aria-placeholder') || element.hasAttribute('data-placeholder')
    || Boolean(element.querySelector('[aria-placeholder], [data-placeholder], [class*="placeholder" i]'))
  return focusable.length === 1 && focusable[0] === element && (labelled || placeholder || element.children.length > 0)
}

function* generateParents(element: Element): Generator<Element> {
  for (let item = element.parentElement; item && item.localName !== 'body'; item = item.parentElement) yield item
}

export const richTextBody = (element: Element): HTMLElement | undefined => {
  if (element.localName !== 'iframe') return undefined
  try {
    const body = (element as HTMLIFrameElement).contentDocument?.body
    return body?.getAttribute('contenteditable') === 'true' ? body : undefined
  } catch {
    return undefined
  }
}

export const isLogicalControl = (element: Element): boolean => {
  if (hidden(element)) return false
  const role = element.getAttribute('role')
  const popup = element.getAttribute('aria-haspopup')
  return element.getAttribute('contenteditable') === 'true'
    || role === 'combobox' || role === 'listbox'
    || popup === 'listbox' || popup === 'tree'
    || customFormControl(element) || Boolean(richTextBody(element))
}

export const logicalControlSelector = '[contenteditable="true"], [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="tree"], [tabindex], iframe'
export const hasClassFragment = classLike
export const isCustomFormControl = customFormControl
