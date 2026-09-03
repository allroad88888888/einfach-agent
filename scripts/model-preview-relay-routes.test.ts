import {
  findProviderRoutePolicy,
  PROVIDER_ROUTE_POLICIES,
  type ProviderTarget,
} from '../packages/agent-ai/src/providerTransport'
import {
  narrowProviderTarget,
  resolveProviderTarget,
} from '../packages/host-node/src/model/providerRoute'
import { providerRouteSpec } from '../apps/web/src/modelTransport/providerRoute'
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
    expect(route('DELETE', '/files/file-api-image_123-A-b')).toEqual({
      target: {
        provider: 'deepseek', scope: 'default', method: 'DELETE',
        path: '/files/file-api-image_123-A-b',
      },
      url: 'https://api.deepseek.com/files/file-api-image_123-A-b',
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
    ['DELETE', '/files/file-api-image.one'],
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
    expect(() => resolveModelPreviewRoute({
      provider: 'deepseek', scope: 'default', method: 'DELETE', path: 123,
    })).toThrow('模型开发中继请求目标未获允许')
  })
})

function representativeTarget(
  policy: (typeof PROVIDER_ROUTE_POLICIES)[number],
): ProviderTarget {
  const path = policy.path.kind === 'exact'
    ? policy.path.value
    : policy.path.idKind === 'deepseek-file'
      ? '/files/file-api-image_123-A-b'
      : '/files/file_123.A-b'
  return {
    provider: policy.provider,
    scope: policy.scope,
    method: policy.method,
    path,
  } as ProviderTarget
}

describe('official provider policy parity', () => {
  it('keeps Web, host-node, and relay aligned with every shared official route', () => {
    const policies = PROVIDER_ROUTE_POLICIES.filter(
      (policy) => policy.officialOrigin !== undefined,
    )
    expect(policies).toHaveLength(7)
    for (const policy of policies) {
      const target = representativeTarget(policy)
      const shared = findProviderRoutePolicy(target)
      expect(shared).toBe(policy)
      const expected = {
        method: target.method,
        path: target.path,
        bodyKind: policy.bodyKind,
        url: `${policy.officialOrigin}${target.path}`,
        maxResponseBytes: policy.maxResponseBytes,
      }
      const web = providerRouteSpec(target)
      const host = resolveProviderTarget(narrowProviderTarget(target))
      const relay = resolveModelPreviewRoute(target)
      expect({ method: target.method, path: target.path, ...web }).toEqual(expected)
      expect({ method: host.method, path: target.path, bodyKind: host.bodyKind,
        url: host.url, maxResponseBytes: host.maxResponseBytes }).toEqual(expected)
      expect({ method: relay.target.method, path: relay.target.path, bodyKind: relay.bodyKind,
        url: relay.url, maxResponseBytes: relay.maxResponseBytes }).toEqual(expected)
    }
  })
})
