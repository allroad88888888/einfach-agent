import type { ToolContext } from '@einfach-agent/core/tools'
export type PageCallContext = Pick<ToolContext, 'sessionId' | 'signal'>
export interface PageRef { targetId: string; documentId: string; revision: number }
export type FieldValue = string | boolean | readonly string[]
export interface FieldOption { label: string; value: string }
export interface FormField { id: string; label: string; kind: string; value: FieldValue; required: boolean; readOnly: boolean; supported: boolean; options?: readonly FieldOption[] }
export interface FormSnapshot { page: PageRef; fields: readonly FormField[] }
export interface FieldOutcome { id: string; ok: boolean; value?: FieldValue; error?: string }
export interface PageToolsHost {
  readForm(ctx: PageCallContext): Promise<FormSnapshot>
  fillFields(input: { page: PageRef; values: readonly { id: string; value: FieldValue }[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
  validateForm(input: { page: PageRef; fieldIds?: readonly string[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
}
export interface ControlledFieldAdapter {
  readonly kind: string
  matches(element: Element): boolean
  read(element: Element): Omit<FormField, 'id' | 'kind'>
  write(element: Element, value: FieldValue, ctx: PageCallContext): Promise<void> | void
  validate?(element: Element): string | undefined
}
export interface DomPageHostOptions { document: Document; targetId: string; documentId?: string; revision?: number; controlledAdapters?: readonly ControlledFieldAdapter[] }
