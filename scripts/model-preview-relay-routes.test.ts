import { describe, expect, it } from 'vitest'
import { resolveModelPreviewRoute } from './model-preview-relay-routes'

function route(method: 'POST' | 'DELETE', path: string) {
  return resolveModelPreviewRoute({
    provider: 'deepseek',
    scope: 'default',
    method,
    path,
  })
}

describe('DeepSeek preview relay file routes', () => {
  it('allows multipart upload at the fixed official origin', () => {
    expect(route('POST', '/files')).toEqual({
      target: {
        provider: 'deepseek', scope: 'default', method: 'POST', path: '/files',
      },
      url: 'https://api.deepseek.com/files',
      bodyKind: 'multipart',
      credential: 'deepseek',
      maxResponseBytes: 4 * 1024 * 1024,
    })
  })

  it('allows DELETE only for a safe file-api ID', () => {
    expect(route('DELETE', '/files/file-api-image_123.A-b')).toEqual({
      target: {
        provider: 'deepseek', scope: 'default', method: 'DELETE',
        path: '/files/file-api-image_123.A-b',
      },
      url: 'https://api.deepseek.com/files/file-api-image_123.A-b',
      bodyKind: 'none',
      credential: 'deepseek',
      maxResponseBytes: 1024 * 1024,
    })
  })

  it.each([
    ['DELETE', '/files/file_123'],
    ['DELETE', '/files/file-api-'],
    ['DELETE', '/files/file-api-image/child'],
    ['DELETE', '/files/file-api-image?query=1'],
    ['DELETE', `/files/file-api-${'a'.repeat(248)}`],
    ['POST', '/files/file-api-image'],
  ] as const)('rejects %s %s', (method, path) => {
    expect(() => route(method, path)).toThrow('模型开发中继请求目标未获允许')
  })

  it('rejects a non-default scope and extra target fields', () => {
    expect(() => resolveModelPreviewRoute({
      provider: 'deepseek', scope: 'cn', method: 'POST', path: '/files',
    })).toThrow('模型开发中继请求目标未获允许')
    expect(() => resolveModelPreviewRoute({
      provider: 'deepseek', scope: 'default', method: 'POST', path: '/files',
      url: 'https://evil.example/files',
    })).toThrow('模型开发中继请求目标未获允许')
  })
})
