import { createHash } from 'node:crypto'

export const CONTENT_HASH_FORMAT_ERROR =
  'expectedContentHash must use sha256:<64 lowercase hex characters>'

const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/** A content hash is always a prefixed, lowercase SHA-256 digest. */
export function hasValidContentHashFormat(value: string): boolean {
  return CONTENT_HASH_PATTERN.test(value)
}

/** Hash text using the UTF-8 bytes used by every workspace mutation guard. */
export function contentSha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}
