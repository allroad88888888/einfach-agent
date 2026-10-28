import { fail } from './network-error'
import type { NetworkCaptureOptions, NetworkListInput, NetworkWaitInput, RequestInput } from './types'

export function validateId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('INVALID_INPUT')
}
export function assertCallContext(ctx: { sessionId: string; signal: AbortSignal }): void {
  validateId(ctx?.sessionId)
  if (!ctx?.signal || typeof ctx.signal.aborted !== 'boolean' || typeof ctx.signal.addEventListener !== 'function') fail('INVALID_INPUT')
}
export function validateCaptureInput(input: unknown): asserts input is { captureId: string } {
  if (!isObject(input)) fail('INVALID_INPUT')
  validateId(input.captureId as string)
}
export function validateRequestInput(input: unknown): asserts input is RequestInput {
  validateCaptureInput(input)
  validateId((input as Record<string, unknown>).requestId as string)
}
export function validateCaptureOptions(input: NetworkCaptureOptions): void {
  if (!isObject(input)) fail('INVALID_INPUT')
  if (input.urlIncludes !== undefined) {
    if (typeof input.urlIncludes !== 'string') fail('INVALID_INPUT')
    validateId(input.urlIncludes)
  }
  if (input.includeBuffered !== undefined && typeof input.includeBuffered !== 'boolean') fail('INVALID_INPUT')
  if (input.methods !== undefined && (
    !Array.isArray(input.methods)
    || input.methods.length > 20
    || input.methods.some((method) => typeof method !== 'string' || !/^[A-Za-z]+$/.test(method))
  )) fail('INVALID_INPUT')
}
export function validateList(input: NetworkListInput): void {
  if (!isObject(input)) fail('INVALID_INPUT')
  const value = input as Record<string, unknown>
  if (value.captureId !== undefined) validateId(value.captureId as string)
  if (value.offset !== undefined && (typeof value.offset !== 'number' || !Number.isInteger(value.offset) || value.offset < 0)) fail('INVALID_INPUT')
  if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) fail('INVALID_INPUT')
  if (value.urlIncludes !== undefined) validateId(value.urlIncludes as string)
  if (value.method !== undefined && (typeof value.method !== 'string' || !/^[A-Za-z]+$/.test(value.method))) fail('INVALID_INPUT')
}
export function validateWait(input: NetworkWaitInput): void {
  if (!isObject(input)) fail('INVALID_INPUT')
  validateId(input.captureId)
  if (input.urlIncludes !== undefined) validateId(input.urlIncludes)
  if (input.state !== undefined && input.state !== 'started' && input.state !== 'finished') fail('INVALID_INPUT')
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000)) fail('INVALID_INPUT')
  if (input.method !== undefined && (typeof input.method !== 'string' || !/^[A-Za-z]+$/.test(input.method))) fail('INVALID_INPUT')
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
