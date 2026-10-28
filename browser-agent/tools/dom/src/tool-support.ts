import type { PageRef } from './types'

export const pageRefSchema = { type: 'object', properties: { targetId: { type: 'string', minLength: 1 }, documentId: { type: 'string', minLength: 1 }, revision: { type: 'integer', minimum: 0 } }, required: ['targetId', 'documentId', 'revision'], additionalProperties: false }
export const readProperties = { page: pageRefSchema, scopeRef: { type: 'string', minLength: 1 }, selector: { type: 'string', minLength: 1, maxLength: 500 }, text: { type: 'string', minLength: 1, maxLength: 500 }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }
export const targetProperties = { page: pageRefSchema, ref: { type: 'string', minLength: 1 } }
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const fail = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error), code: 'DOM_TOOL_FAILED', retryable: false })
export const target = (input: Record<string, unknown>) => ({ page: input.page as PageRef, ref: input.ref as string })
