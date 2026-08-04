import { fnv1a32 } from './shared/hash'

/** Produces stable, privacy-safe hashes for context cache comparisons. */
export function canonicalContextCacheValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return '"[undefined]"'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalContextCacheValue(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalContextCacheValue(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

export function contextCacheFingerprintText(kind: string, text: string): string {
  return `${kind}-v2-fnv1a32-${fnv1a32(text)}`
}

export function contextCacheFingerprint(kind: string, value: unknown): string {
  return contextCacheFingerprintText(kind, canonicalContextCacheValue(value))
}
