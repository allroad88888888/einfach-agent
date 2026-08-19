import { isValidProviderRequestId, type ProviderWireRequest } from '@einfach-agent/ai'
import { describe, expect, it } from 'vitest'
import {
  encodeProviderWireRequest,
  validateProviderWireRequestSize,
} from './providerWireEnvelope'

const request: ProviderWireRequest = {
  target: {
    provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions',
  },
  body: { kind: 'json', json: '{}' },
  requestId: 'request-1',
}

describe('provider wire envelope', () => {
  it('uses the same complete canonical byte boundary as native serde', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
    expect(bytes).toBe(154)
    expect(() => validateProviderWireRequestSize(request, bytes)).not.toThrow()
    expect(() => validateProviderWireRequestSize(request, bytes - 1))
      .toThrow('模型请求格式无效')
  })

  it('restricts request IDs to the native registry contract', async () => {
    expect(isValidProviderRequestId('model_1-A')).toBe(true)
    expect(isValidProviderRequestId('')).toBe(false)
    expect(isValidProviderRequestId('request with spaces')).toBe(false)
    expect(isValidProviderRequestId('r'.repeat(129))).toBe(false)
    await expect(encodeProviderWireRequest({
      target: request.target,
      body: { kind: 'json', json: '{}' },
    }, 'bad request')).rejects.toThrow('模型请求格式无效')
  })
})
