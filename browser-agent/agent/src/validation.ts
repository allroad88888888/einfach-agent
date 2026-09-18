export function required(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  return normalized
}

export function endpoint(value: string): string {
  const normalized = required(value, 'baseUrl')
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error('baseUrl must be a valid URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('baseUrl must not contain credentials, query, or hash')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) {
    throw new Error('baseUrl must use https or loopback http')
  }
  return url.href.replace(/\/$/, '')
}

export function unique(values: readonly string[], field: string): string[] {
  const result = values.map((value) => required(value, field))
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`)
  return result
}

export function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
