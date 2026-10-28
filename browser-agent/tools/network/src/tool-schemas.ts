export const captureId = { type: 'string', minLength: 1, maxLength: 500 }
export const requestId = { type: 'string', minLength: 1, maxLength: 500 }
export const captureSchema = { type: 'object', properties: { captureId }, required: ['captureId'], additionalProperties: false } as const
export const requestSchema = { type: 'object', properties: { captureId, requestId }, required: ['captureId', 'requestId'], additionalProperties: false } as const
