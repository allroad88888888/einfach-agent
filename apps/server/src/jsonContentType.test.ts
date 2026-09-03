import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { hasJsonContentType } from './jsonContentType'

function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(new EventEmitter(), { headers }) as unknown as IncomingMessage
}

describe('hasJsonContentType', () => {
  it('accepts application/json case-insensitively and with parameters', () => {
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'application/json' }))).toBe(true)
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'Application/JSON' }))).toBe(true)
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true)
  })

  it('rejects missing headers and form-submittable media types', () => {
    expect(hasJsonContentType(fakeRequest())).toBe(false)
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false)
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'multipart/form-data; boundary=x' }))).toBe(false)
    expect(hasJsonContentType(fakeRequest({ 'content-type': 'text/plain' }))).toBe(false)
  })
})
