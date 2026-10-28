import type { FormField, PageCallContext, PageRef, PageToolsHost } from './types'

export const samePage = (left: PageRef, right: PageRef): boolean => left.targetId === right.targetId && left.documentId === right.documentId && left.revision === right.revision
export async function readField(host: PageToolsHost, page: PageRef, fieldId: string, ctx: PageCallContext): Promise<FormField> {
  const snapshot = await host.readForm(ctx)
  if (!samePage(page, snapshot.page)) throw new Error('page reference is stale or belongs to another target')
  const field = snapshot.fields.find(({ id }) => id === fieldId)
  if (!field) throw new Error('field is missing or was replaced')
  return field
}
export const numberPageSchema = { type: 'integer', minimum: 0 }
export const limitSchema = { type: 'integer', minimum: 1, maximum: 100 }
