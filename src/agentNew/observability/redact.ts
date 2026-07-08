import type { TraceAttributes } from './types'

const DEFAULT_STRING_LIMIT = 500
const DEFAULT_JSON_LIMIT = 2_000
const DEFAULT_DEPTH = 4
const DEFAULT_PREVIEW_DEPTH = 5
const DEFAULT_PREVIEW_ITEMS = 20
const DEFAULT_PREVIEW_KEYS = 40
const EXPLICIT_PREVIEW_STRING_LIMIT = 100_000

const SENSITIVE_KEY = /(api[_-]?key|authorization|bearer|token|secret|password|passwd)/i
const PAYLOAD_KEY = /^(prompt|messages?|response|completion|content|reasoning_content|arguments|args|result|answers)$/i
const EXPLICIT_PREVIEW_KEY = /Preview$/
const BEARER_VALUE = /\bBearer\s+[^\s,}]+/gi
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const SECRET_ASSIGNMENT =
  /(\b(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\b["']?\s*[:=]\s*["']?)[^"',\s}]+/gi

export interface SafePayloadPreviewOptions {
  stringLimit?: number
  depth?: number
  itemLimit?: number
  keyLimit?: number
}

interface NormalizedPreviewOptions {
  stringLimit: number
  depth: number
  itemLimit: number
  keyLimit: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[Unserializable]'
  }
}

function safeKeyCount(value: object): number {
  try {
    return Object.keys(value).length
  } catch {
    return 0
  }
}

function maskSensitiveText(value: string): string {
  return value
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(OPENAI_STYLE_KEY, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
}

function truncateString(value: string, limit = DEFAULT_STRING_LIMIT): string {
  const masked = maskSensitiveText(value)
  if (masked.length <= limit) return masked
  return `${masked.slice(0, limit)}...<truncated ${masked.length - limit} chars>`
}

function payloadSummary(value: unknown): TraceAttributes {
  if (typeof value === 'string') {
    return { redacted: true, kind: 'string', chars: value.length }
  }
  if (Array.isArray(value)) {
    return { redacted: true, kind: 'array', items: value.length }
  }
  if (isPlainObject(value)) {
    return { redacted: true, kind: 'object', keys: safeKeyCount(value) }
  }
  return { redacted: true, kind: value === null ? 'null' : typeof value }
}

function redactValue(
  value: unknown,
  depth: number,
  seen = new WeakSet<object>(),
  stringLimit = DEFAULT_STRING_LIMIT,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(value, stringLimit)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return safeString(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (depth <= 0) return payloadSummary(value)
  if (typeof value !== 'object') return safeString(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      return value.slice(0, DEFAULT_PREVIEW_ITEMS).map((item) => redactValue(item, depth - 1, seen, stringLimit))
    }
    if (!isPlainObject(value)) return safeString(value)

    const out: TraceAttributes = {}
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[REDACTED]'
      } else if (PAYLOAD_KEY.test(key)) {
        out[key] = payloadSummary(child)
      } else {
        const childStringLimit = EXPLICIT_PREVIEW_KEY.test(key) ? EXPLICIT_PREVIEW_STRING_LIMIT : stringLimit
        out[key] = redactValue(child, depth - 1, seen, childStringLimit)
      }
    }
    return out
  } catch {
    return safeString(value)
  } finally {
    seen.delete(value)
  }
}

// 简介：trace attrs 默认脱敏。payload 类字段只保留形状，避免误落完整 prompt/response。
export function redactAttributes(attrs?: TraceAttributes): TraceAttributes | undefined {
  if (!attrs) return undefined
  return redactValue(attrs, DEFAULT_DEPTH) as TraceAttributes
}

function previewKey(key: PropertyKey): string {
  return typeof key === 'symbol' ? key.toString() : String(key)
}

function safeOwnKeys(value: object): PropertyKey[] {
  try {
    return Reflect.ownKeys(value)
  } catch {
    return []
  }
}

function safeProperty(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'get' in descriptor && descriptor.get) return '[Getter]'
    if (descriptor && 'value' in descriptor) return descriptor.value
    return (value as Record<PropertyKey, unknown>)[key]
  } catch (err) {
    return `[Unreadable: ${errorMessage(err)}]`
  }
}

function normalizePreviewOptions(options: SafePayloadPreviewOptions = {}): NormalizedPreviewOptions {
  return {
    stringLimit: options.stringLimit ?? DEFAULT_STRING_LIMIT,
    depth: options.depth ?? DEFAULT_PREVIEW_DEPTH,
    itemLimit: options.itemLimit ?? DEFAULT_PREVIEW_ITEMS,
    keyLimit: options.keyLimit ?? DEFAULT_PREVIEW_KEYS,
  }
}

function normalizePreviewValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  options: NormalizedPreviewOptions,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(value, options.stringLimit)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return safeString(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return safeString(value)
  if (seen.has(value)) return '[Circular]'
  if (depth <= 0) return payloadSummary(value)

  seen.add(value)
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateString(value.message, options.stringLimit),
      }
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? safeString(value) : value.toISOString()
    if (value instanceof RegExp) return safeString(value)
    if (Array.isArray(value)) {
      const items = value
        .slice(0, options.itemLimit)
        .map((item) => normalizePreviewValue(item, depth - 1, seen, options))
      if (value.length > options.itemLimit) items.push(`...<truncated ${value.length - options.itemLimit} items>`)
      return items
    }
    if (value instanceof Map) {
      return {
        kind: 'Map',
        entries: Array.from(value.entries())
          .slice(0, options.itemLimit)
          .map(([key, child]) => [
            normalizePreviewValue(key, depth - 1, seen, options),
            normalizePreviewValue(child, depth - 1, seen, options),
          ]),
        truncated: Math.max(0, value.size - options.itemLimit),
      }
    }
    if (value instanceof Set) {
      return {
        kind: 'Set',
        values: Array.from(value.values())
          .slice(0, options.itemLimit)
          .map((child) => normalizePreviewValue(child, depth - 1, seen, options)),
        truncated: Math.max(0, value.size - options.itemLimit),
      }
    }

    const out: TraceAttributes = {}
    const keys = safeOwnKeys(value)
    for (const key of keys.slice(0, options.keyLimit)) {
      const textKey = previewKey(key)
      out[textKey] = SENSITIVE_KEY.test(textKey)
        ? '[REDACTED]'
        : normalizePreviewValue(safeProperty(value, key), depth - 1, seen, options)
    }
    if (keys.length > options.keyLimit) {
      out.__truncatedKeys = keys.length - options.keyLimit
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function previewText(value: unknown): string {
  if (typeof value === 'string') return value
  const text = JSON.stringify(value)
  return text === undefined ? safeString(value) : text
}

// 简介：给 tool args/result/error 用的安全预览。保留可读摘要，但会脱敏、处理循环引用并截断。
export function safePayloadPreview(
  payload: unknown,
  limit = DEFAULT_JSON_LIMIT,
  options?: SafePayloadPreviewOptions,
): string {
  try {
    const normalizedOptions = normalizePreviewOptions(options)
    const normalized = normalizePreviewValue(payload, normalizedOptions.depth, new WeakSet<object>(), normalizedOptions)
    return truncateString(previewText(normalized), limit)
  } catch {
    return truncateString(safeString(payload), limit)
  }
}

function sourceValue(attrs: TraceAttributes, keys: string[]): unknown {
  for (const key of keys) {
    if (attrs[key] !== undefined) return attrs[key]
  }
  return undefined
}

// 简介：写 trace 前补出安全 preview，再套默认 attrs 脱敏策略。
export function redactAttributesWithPreviews(attrs?: TraceAttributes): TraceAttributes | undefined {
  if (!attrs) return undefined
  const withPreviews: TraceAttributes = { ...attrs }
  const args = sourceValue(attrs, ['args', 'arguments'])
  const result = sourceValue(attrs, ['result'])
  const error = sourceValue(attrs, ['error'])
  if (withPreviews.argsPreview === undefined && args !== undefined) withPreviews.argsPreview = safePayloadPreview(args)
  if (withPreviews.resultPreview === undefined && result !== undefined) withPreviews.resultPreview = safePayloadPreview(result)
  if (withPreviews.errorPreview === undefined && error !== undefined) withPreviews.errorPreview = safePayloadPreview(error)
  return redactAttributes(withPreviews)
}

// 简介：显式需要保留预览时使用的截断 helper；仍会先屏蔽敏感字段。
export function truncatePayload(payload: unknown, limit = DEFAULT_JSON_LIMIT, options?: SafePayloadPreviewOptions): string {
  return safePayloadPreview(payload, limit, options)
}

export function errorMessage(err: unknown): string {
  return truncateString(err instanceof Error ? err.message : String(err))
}
