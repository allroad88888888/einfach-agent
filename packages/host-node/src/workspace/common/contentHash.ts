import { createHash } from 'node:crypto'

export const CONTENT_HASH_FORMAT_ERROR =
  'expectedContentHash must use sha256:<64 lowercase hex characters>'

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/** A workspace content hash is always a prefixed, lowercase SHA-256 digest. */
export function hasValidContentHashFormat(value: string): boolean {
  return CONTENT_HASH_PATTERN.test(value)
}

/** Hash the exact bytes guarded by the workspace optimistic-concurrency protocol. */
export function contentSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
