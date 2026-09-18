import { candidateElements, isNativeField, nativeSupported, nativeValue, readResolved, type NativeField, type ResolvedField } from './dom-fields'
import { assertWritable, writeResolved } from './dom-write'
import { enqueueDocumentWrite } from './document-write-queue'
import type { DomPageHostOptions, FieldOutcome, FieldValue, PageCallContext, PageRef, PageToolsHost } from './types'
const aborted = (ctx: PageCallContext): void => { if (ctx.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError') }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
function sameValue(expected: FieldValue, actual: FieldValue): boolean {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return expected === actual
  const left = new Set(expected); const right = new Set(actual)
  return left.size === right.size && Array.from(left).every((value) => right.has(value))
}
export function createDomPageHost(options: DomPageHostOptions): PageToolsHost {
  const { document, targetId, controlledAdapters = [] } = options
  const page: PageRef = { targetId, documentId: options.documentId ?? crypto.randomUUID(), revision: options.revision ?? 1 }
  const identities = new WeakMap<Element, string>(); let nextId = 1
  const idFor = (element: Element): string => { const found = identities.get(element); if (found) return found; const id = `field-${nextId++}`; identities.set(element, id); return id }
  const fields = (): ResolvedField[] => candidateElements(document, controlledAdapters)
  const resolve = (id: string): ResolvedField | undefined => fields().find(({ element }) => identities.get(element) === id)
  const currentDocument = (): boolean => document.defaultView?.document === document
  const pageError = (ref: PageRef): string | undefined => {
    if (ref.targetId !== page.targetId || ref.documentId !== page.documentId || ref.revision !== page.revision) return 'page reference is stale or belongs to another target'
    if (!currentDocument()) return 'document binding is no longer current'
  }
  const actualValue = (field: ResolvedField): FieldValue => field.adapter ? field.adapter.read(field.element).value : isNativeField(field.element) ? nativeValue(field.element) : ''
  return {
    async readForm(ctx) { aborted(ctx); if (!currentDocument()) throw new Error('document binding is no longer current'); return { page: { ...page }, fields: fields().map((field) => readResolved(field, idFor(field.element))) } },
    fillFields(input, ctx) {
      return enqueueDocumentWrite(document, async () => {
        aborted(ctx)
        const outcomes: FieldOutcome[] = []
        for (const item of input.values) {
          aborted(ctx)
          const stale = pageError(input.page)
          if (stale) { outcomes.push({ id: item.id, ok: false, error: stale }); continue }
          const field = resolve(item.id)
          if (!field) { outcomes.push({ id: item.id, ok: false, error: 'field is missing or was replaced' }); continue }
          const blocked = assertWritable(field)
          if (blocked) { outcomes.push({ id: item.id, ok: false, error: blocked }); continue }
          try {
            const error = await writeResolved(field, item.value, ctx); aborted(ctx)
            const lateError = pageError(input.page) ?? (resolve(item.id)?.element !== field.element ? 'field was replaced during write' : assertWritable(field))
            const actual = actualValue(field)
            if (error || lateError) outcomes.push({ id: item.id, ok: false, value: actual, error: error ?? lateError })
            else if (!sameValue(item.value, actual)) outcomes.push({ id: item.id, ok: false, value: actual, error: 'field did not retain the requested value' })
            else outcomes.push({ id: item.id, ok: true, value: actual })
          } catch (error) { if (ctx.signal.aborted) throw error; outcomes.push({ id: item.id, ok: false, error: message(error) }) }
        }
        return outcomes
      })
    },
    async validateForm(input, ctx) {
      aborted(ctx); const stale = pageError(input.page); const ids = input.fieldIds ?? fields().map(({ element }) => idFor(element))
      if (stale) return ids.map((id) => ({ id, ok: false, error: stale }))
      return ids.map((id): FieldOutcome => {
        aborted(ctx); const field = resolve(id); if (!field) return { id, ok: false, error: 'field is missing or was replaced' }
        const native = field.element as NativeField
        const unsupported = !field.adapter && (!isNativeField(field.element) || !nativeSupported(field.element))
        const error = unsupported ? 'field type is unsupported' : field.adapter?.validate?.(field.element) ?? (!field.adapter && !native.checkValidity() ? native.validationMessage || 'field is invalid' : undefined)
        return error ? { id, ok: false, value: actualValue(field), error } : { id, ok: true, value: actualValue(field) }
      })
    },
  }
}
