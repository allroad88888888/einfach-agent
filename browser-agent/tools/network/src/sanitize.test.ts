import { describe, expect, it } from 'vitest'
import { sanitizeBody, sanitizeUrl } from './sanitize'

describe('network redaction', () => {
  it('redacts camel, snake, kebab, and spaced credential keys in URLs', () => {
    const url = sanitizeUrl(
      '/oauth?client_secret=a&refreshToken=b&auth-token=c&session_id=d&csrfToken=e&API%20key=f&name=safe',
      'https://user:pass@example.test/base#secret',
    )
    expect(url).not.toMatch(/user|pass|client_secret=a|refreshToken=b|auth-token=c|session_id=d|csrfToken=e|API(?:%20|\+)key=f|#secret/)
    expect(url).toContain('name=safe')
  })

  it('recursively redacts JSON and urlencoded bodies', () => {
    const json = sanitizeBody('{"profile":{"client_secret":"a","refreshToken":"b","name":"safe"}}', 'application/json', 1024)
    expect(json.body).toBe('{"profile":{"client_secret":"[REDACTED]","refreshToken":"[REDACTED]","name":"safe"}}')
    const form = sanitizeBody('auth-token=a&session_id=b&name=safe', 'application/x-www-form-urlencoded', 1024)
    expect(form.body).toContain('auth-token=%5BREDACTED%5D')
    expect(form.body).toContain('session_id=%5BREDACTED%5D')
  })

  it('omits malformed and over-limit JSON instead of exposing a prefix', () => {
    const malformed = sanitizeBody('{"token":"secret"', 'application/json', 1024)
    expect(malformed).toMatchObject({ state: 'omitted' })
    expect(malformed).not.toHaveProperty('body')
    const oversized = sanitizeBody('{"name":"long value"}', 'application/json', 5)
    expect(oversized).toMatchObject({ state: 'omitted', truncated: true })
    expect(oversized).not.toHaveProperty('body')
  })
})
