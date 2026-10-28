const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

export function isDomVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (blockedTags.has(current.tagName)) return false
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
  }
  return !(element.localName === 'input' && (element as HTMLInputElement).type === 'hidden')
}

export function isDisabled(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.getAttribute('aria-disabled') === 'true') return true
    if ('disabled' in current && Boolean((current as HTMLButtonElement).disabled)) {
      if (current.localName !== 'fieldset') return true
      const firstLegend = Array.from(current.children).find((child) => child.localName === 'legend')
      if (!firstLegend?.contains(element)) return true
    }
  }
  return false
}

export function isReadOnly(element: Element): boolean {
  return ('readOnly' in element && Boolean((element as HTMLInputElement).readOnly)) || element.getAttribute('aria-readonly') === 'true'
}
