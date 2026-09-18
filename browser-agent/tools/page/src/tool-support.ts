import type { FieldValue, PageRef } from './types'
export const pageRefSchema = { type: 'object', properties: { targetId: { type: 'string' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 0 } }, required: ['targetId', 'documentId', 'revision'], additionalProperties: false }
export const valueSchema = { oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }] }
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const fail = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error), code: 'PAGE_TOOL_FAILED', retryable: false })
export type FillInput = { page: PageRef; values: { id: string; value: FieldValue }[] }
