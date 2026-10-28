import type { ToolContext } from '@einfach-agent/core/tools'
export type PageCallContext = Pick<ToolContext, 'sessionId' | 'signal'>
export interface PageRef { targetId: string; documentId: string; revision: number }
export type FieldValue = string | boolean | readonly string[]
export interface FieldOption { label: string; value: string; disabled?: boolean }
export type FieldOptionsStatus = 'exposed' | 'not-exposed'
export interface FormField { id: string; label: string; kind: string; value: FieldValue; required: boolean; readOnly: boolean; supported: boolean; options?: readonly FieldOption[]; optionLabels?: readonly string[]; optionsStatus?: FieldOptionsStatus }
export interface FormSnapshot { page: PageRef; fields: readonly FormField[] }
export interface PageReadInput { maxChars?: number }
export interface PageSnapshot { page: PageRef; title: string; url: string; text: string; truncated: boolean; tables: readonly { id: string; caption: string; rowCount: number; columnCount: number }[] }
export interface ReadTableInput { page: PageRef; tableId: string; offset?: number; limit?: number }
export interface TableSnapshot { page: PageRef; tableId: string; headers: readonly string[]; rows: readonly (readonly string[])[]; nextOffset?: number; truncated: boolean }
export interface FieldOutcome { id: string; ok: boolean; value?: FieldValue; error?: string }
export interface PageToolsHost {
  readForm(ctx: PageCallContext): Promise<FormSnapshot>
  fillFields(input: { page: PageRef; values: readonly { id: string; value: FieldValue }[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
  validateForm(input: { page: PageRef; fieldIds?: readonly string[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
  readPage?(input: PageReadInput, ctx: PageCallContext): Promise<PageSnapshot>
  readTable?(input: ReadTableInput, ctx: PageCallContext): Promise<TableSnapshot>
}
export interface ControlledFieldAdapter {
  readonly kind: string
  matches(element: Element): boolean
  read(element: Element): Omit<FormField, 'id' | 'kind'>
  write(element: Element, value: FieldValue, ctx: PageCallContext): Promise<void> | void
  validate?(element: Element): string | undefined
}
export interface DomPageHostOptions { document: Document; targetId: string; documentId?: string; revision?: number; controlledAdapters?: readonly ControlledFieldAdapter[] }
