import type { PageCallContext, PageReadInput, PageRef, PageSnapshot, ReadTableInput, TableSnapshot } from './types'

const hiddenSelf = (element: Element): boolean => {
  const html = element as HTMLElement
  const style = element.ownerDocument.defaultView?.getComputedStyle(html)
  return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true' || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
}
const hiddenByClosedDetails = (element: Element): boolean => {
  for (let item = element.parentElement; item; item = item.parentElement) {
    if (item.localName !== 'details' || item.hasAttribute('open')) continue
    const summary = Array.from(item.children).find((child) => child.localName === 'summary')
    if (!summary?.contains(element)) return true
  }
  return false
}
const hidden = (element: Element): boolean => {
  if (hiddenByClosedDetails(element)) return true
  for (let item: Element | null = element; item; item = item.parentElement) if (hiddenSelf(item)) return true
  return false
}
const excluded = (element: Element): boolean => {
  for (let item: Element | null = element; item; item = item.parentElement) {
    if (['script', 'style', 'template', 'input', 'textarea', 'select'].includes(item.localName) || hiddenSelf(item)) return true
  }
  return hiddenByClosedDetails(element)
}
const clean = (value: string | null | undefined, max = 500): { value: string; truncated: boolean } => {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  return { value: normalized.slice(0, max), truncated: normalized.length > max }
}
const current = (document: Document): boolean => document.defaultView?.document === document
const samePage = (left: PageRef, right: PageRef): boolean => left.targetId === right.targetId && left.documentId === right.documentId && left.revision === right.revision
const visibleText = (element: Element | null | undefined, max = 500): { value: string; truncated: boolean } => {
  if (!element || excluded(element)) return { value: '', truncated: false }
  const walker = element.ownerDocument.createTreeWalker(element, 4)
  const parts: string[] = []; let node = walker.nextNode()
  while (node) { const parent = node.parentElement; if (parent && !excluded(parent)) parts.push(node.textContent ?? ''); node = walker.nextNode() }
  return clean(parts.join(' '), max)
}
const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number, name: string): number => {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return result
}

export function createDomPageReader(document: Document, page: PageRef) {
  const ids = new WeakMap<HTMLTableElement, string>(); let nextId = 1
  const tables = (): HTMLTableElement[] => Array.from(document.querySelectorAll('table')).filter((table) => !hidden(table))
  const visibleCells = (row: HTMLTableRowElement): HTMLTableCellElement[] => hidden(row) ? [] : Array.from(row.cells).filter((cell) => !hidden(cell))
  const idFor = (table: HTMLTableElement): string => { const found = ids.get(table); if (found) return found; const id = `table-${nextId++}`; ids.set(table, id); return id }
  const assertActive = (ctx: PageCallContext): void => { if (ctx.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError'); if (!current(document)) throw new Error('document binding is no longer current') }
  return {
    async readPage(input: PageReadInput, ctx: PageCallContext): Promise<PageSnapshot> {
      assertActive(ctx)
      const maxChars = boundedInteger(input.maxChars, 12_000, 1, 20_000, 'maxChars')
      const body = visibleText(document.body, maxChars)
      return { page: { ...page }, title: document.title, url: document.URL, text: body.value, truncated: body.truncated, tables: tables().slice(0, 50).map((table) => { const rows = Array.from(table.rows).filter((row) => visibleCells(row).length > 0); return { id: idFor(table), caption: visibleText(table.caption).value, rowCount: rows.length, columnCount: rows.reduce((max, row) => Math.max(max, visibleCells(row).length), 0) } }) }
    },
    async readTable(input: ReadTableInput, ctx: PageCallContext): Promise<TableSnapshot> {
      assertActive(ctx)
      if (!samePage(input.page, page)) throw new Error('page reference is stale or belongs to another target')
      const table = tables().find((candidate) => ids.get(candidate) === input.tableId)
      if (!table) throw new Error('table is missing or was replaced')
      const offset = boundedInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'); const limit = boundedInteger(input.limit, 20, 1, 100, 'limit')
      const allRows = Array.from(table.rows).filter((row) => visibleCells(row).length > 0); const headerRow = allRows.find((row) => visibleCells(row).every((cell) => cell.localName === 'th'))
      const headers = headerRow ? visibleCells(headerRow).slice(0, 50).map((cell) => visibleText(cell).value) : []
      const dataRows = headerRow ? allRows.filter((row) => row !== headerRow) : allRows
      let truncated = dataRows.length > offset + limit || (headerRow ? visibleCells(headerRow).length > 50 : false)
      if (headerRow) for (const cell of visibleCells(headerRow).slice(0, 50)) truncated ||= visibleText(cell).truncated
      const rows = dataRows.slice(offset, offset + limit).map((row) => visibleCells(row).slice(0, 50).map((cell) => { const item = visibleText(cell); truncated ||= item.truncated || visibleCells(row).length > 50; return item.value }))
      const nextOffset = offset + rows.length < dataRows.length ? offset + rows.length : undefined
      return { page: { ...page }, tableId: input.tableId, headers, rows, ...(nextOffset === undefined ? {} : { nextOffset }), truncated }
    },
  }
}
