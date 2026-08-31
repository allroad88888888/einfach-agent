import { describe, expect, it } from 'vitest'
import { parseModelConnectionProfileManifest } from './modelConnectionProfileManifest'

function manifest(connection: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, connection })
}

const MINIMUM_CONNECTION = {
  label: 'Community Gateway',
  kind: 'openai-compatible',
  baseUrl: 'https://gateway.example.com/v1/',
  models: [{ id: 'community-model' }],
}

describe('parseModelConnectionProfileManifest', () => {
  it('parses the minimum non-secret manifest into manual model drafts', () => {
    expect(parseModelConnectionProfileManifest(manifest(MINIMUM_CONNECTION))).toEqual({
      label: 'Community Gateway',
      baseUrl: 'https://gateway.example.com/v1',
      models: [{ id: 'community-model', label: 'community-model', source: 'manual' }],
    })
  })

  it('keeps an optional model label', () => {
    const result = parseModelConnectionProfileManifest(manifest({
      ...MINIMUM_CONNECTION,
      models: [{ id: 'community-model', label: 'Community Model' }],
    }))
    expect(result.models).toEqual([
      { id: 'community-model', label: 'Community Model', source: 'manual' },
    ])
  })

  it.each([
    JSON.stringify({ version: 1, connection: MINIMUM_CONNECTION, unexpected: true }),
    manifest({ ...MINIMUM_CONNECTION, id: 'must-stay-local' }),
    manifest({ ...MINIMUM_CONNECTION, apiKey: 'not-allowed' }),
    JSON.stringify({ version: 1, connection: { ...MINIMUM_CONNECTION, token: 'not-allowed' } }),
    manifest({ ...MINIMUM_CONNECTION, headers: { Authorization: 'not-allowed' } }),
    manifest({ ...MINIMUM_CONNECTION, apiPath: '/v1' }),
    manifest({ ...MINIMUM_CONNECTION, adapter: 'custom' }),
    manifest({ ...MINIMUM_CONNECTION, models: [{ id: 'community-model', apiKey: 'not-allowed' }] }),
  ])('rejects every unknown field without retaining it', (input) => {
    expect(() => parseModelConnectionProfileManifest(input)).toThrow('连接清单包含不支持的字段。')
  })

  it('rejects duplicate model IDs', () => {
    expect(() => parseModelConnectionProfileManifest(manifest({
      ...MINIMUM_CONNECTION,
      models: [{ id: 'community-model' }, { id: 'community-model' }],
    }))).toThrow('连接清单模型 ID 不可重复。')
  })

  it.each([
    'http://gateway.example.com/v1',
    'https://user:password@gateway.example.com/v1',
    'https://gateway.example.com/v1?apiKey=not-allowed',
    'https://gateway.example.com/v1#token',
  ])('rejects an unsafe base URL without echoing it', (baseUrl) => {
    const input = manifest({ ...MINIMUM_CONNECTION, baseUrl })
    expect(() => parseModelConnectionProfileManifest(input)).toThrow('连接清单接入点地址无效。')
    try {
      parseModelConnectionProfileManifest(input)
    } catch (error) {
      expect(String(error)).not.toContain(baseUrl)
      expect(String(error)).not.toContain('password')
    }
  })

  it('accepts HTTP only for the same loopback forms as the host validator', () => {
    const result = parseModelConnectionProfileManifest(manifest({
      ...MINIMUM_CONNECTION,
      baseUrl: 'http://127.1:8080/v1/',
    }))
    expect(result.baseUrl).toBe('http://127.0.0.1:8080/v1')
  })

  it('rejects a manifest whose text is too large', () => {
    expect(() => parseModelConnectionProfileManifest(' '.repeat(64 * 1024 + 1)))
      .toThrow('连接清单文本过大。')
  })

  it('returns no secret fields', () => {
    const result = parseModelConnectionProfileManifest(manifest(MINIMUM_CONNECTION))
    expect(JSON.stringify(result)).not.toContain('apiKey')
    expect(JSON.stringify(result)).not.toContain('token')
    expect(JSON.stringify(result)).not.toContain('headers')
  })
})
