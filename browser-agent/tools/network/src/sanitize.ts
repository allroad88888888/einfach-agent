const sensitiveWords = new Set([
  'apikey',
  'authorization',
  'cookie',
  'csrf',
  'password',
  'passwd',
  'secret',
  'session',
  'token',
])
const allowedHeaders = new Set(['accept', 'content-type', 'content-length', 'cache-control', 'pragma', 'range'])

export function sanitizeUrl(value: string, base: string): string {
  try {
    const url = new URL(value, base)
    url.username = ''; url.password = ''; url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.href
  } catch { return 'about:invalid' }
}

export function sanitizeHeaders(source: Headers | string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  const headers = typeof source === 'string' ? parseRawHeaders(source) : source
  headers.forEach((value, key) => { if (allowedHeaders.has(key.toLowerCase())) result[key.toLowerCase()] = value.slice(0, 1024) })
  return result
}

function parseRawHeaders(raw: string): Headers {
  const headers = new Headers()
  for (const line of raw.split(/\r?\n/)) {
    const split = line.indexOf(':')
    if (split > 0) headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim())
  }
  return headers
}

export function sanitizeBody(text: string, contentType: string, limit: number): { body?: string; state: 'captured' | 'omitted'; truncated: boolean; reason?: string } {
  if (text.length > limit && /json/i.test(contentType)) return { state: 'omitted', truncated: true, reason: 'response body exceeded safe JSON limit' }
  if (/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(text)
      const body = JSON.stringify(redact(parsed, 0, { count: 0 }))
      return body.length <= limit ? { body, state: 'captured', truncated: false } : { state: 'omitted', truncated: true, reason: 'response body exceeded safe JSON limit' }
    } catch { return { state: 'omitted', truncated: false, reason: 'response body was not safe JSON' } }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams(text)
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) params.set(key, '[REDACTED]')
    }
    const body = params.toString(); return { body: body.slice(0, limit), state: 'captured', truncated: body.length > limit }
  }
  if (/^text\/plain(?:;|$)/i.test(contentType)) return { body: text.slice(0, limit), state: 'captured', truncated: text.length > limit }
  return { state: 'omitted', truncated: false, reason: 'response body type is not safely readable' }
}

function redact(value: unknown, depth: number, budget: { count: number }): unknown {
  if (depth > 8 || ++budget.count > 500) throw new Error('limit')
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, budget))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? '[REDACTED]' : redact(item, depth + 1, budget),
      ]),
    )
  }
  return typeof value === 'string' ? value.slice(0, 4096) : value
}

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const collapsed = words.join('')
  return words.some((word) => sensitiveWords.has(word)) || sensitiveWords.has(collapsed)
}
