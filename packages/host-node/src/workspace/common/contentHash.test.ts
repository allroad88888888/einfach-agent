import { describe, expect, it } from 'vitest'
import { contentSha256, hasValidContentHashFormat } from './contentHash'

const utf8 = (value: string): Uint8Array => Buffer.from(value, 'utf8')

describe('workspace content hash protocol', () => {
  it.each([
    ['', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['你好', 'sha256:670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e'],
  ])('hashes the UTF-8 bytes of %j', (input, expected) => {
    expect(contentSha256(utf8(input))).toBe(expected)
  })

  it('accepts only sha256 followed by 64 lowercase hex characters', () => {
    const hash = contentSha256(utf8('strict'))
    expect(hasValidContentHashFormat(hash)).toBe(true)
    expect(hasValidContentHashFormat(hash.slice('sha256:'.length))).toBe(false)
    expect(hasValidContentHashFormat(hash.toUpperCase())).toBe(false)
    expect(hasValidContentHashFormat(`${hash}\n`)).toBe(false)
    expect(hasValidContentHashFormat(`sha256:${'a'.repeat(63)}`)).toBe(false)
    expect(hasValidContentHashFormat(`sha256:${'g'.repeat(64)}`)).toBe(false)
  })
})
