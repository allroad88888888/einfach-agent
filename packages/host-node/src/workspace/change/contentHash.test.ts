import { describe, expect, it } from 'vitest'
import { contentSha256, hasValidContentHashFormat } from './contentHash'

describe('workspace mutation content hash primitives', () => {
  it('hashes UTF-8 content using the prefixed lowercase SHA-256 form', () => {
    expect(contentSha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('accepts exactly sha256 followed by 64 lowercase hex characters', () => {
    const hash = contentSha256('你好')
    expect(hasValidContentHashFormat(hash)).toBe(true)
    expect(hasValidContentHashFormat(hash.slice('sha256:'.length))).toBe(false)
    expect(hasValidContentHashFormat(hash.toUpperCase())).toBe(false)
    expect(hasValidContentHashFormat(`${hash}\n`)).toBe(false)
    expect(hasValidContentHashFormat(`sha256:${'a'.repeat(63)}`)).toBe(false)
    expect(hasValidContentHashFormat(`sha256:${'g'.repeat(64)}`)).toBe(false)
  })
})
