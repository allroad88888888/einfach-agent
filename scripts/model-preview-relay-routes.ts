import {
  findProviderRoutePolicy,
  type ProviderRequestBody,
  type ProviderTarget,
} from '../packages/agent-ai/src/providerTransport'
import { RelayRequestError } from './model-preview-relay-error'

export type ModelPreviewRelayCredentials = {
  deepseek?: string
  glm?: string
  kimi?: string
}

export type ModelPreviewRoute = {
  target: ProviderTarget
  url: string
  bodyKind: ProviderRequestBody['kind']
  credential: keyof ModelPreviewRelayCredentials
  maxResponseBytes: number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayRequestError(400, '模型开发中继请求格式无效。')
  }
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function resolved(
  target: Record<string, unknown>,
  url: string,
  bodyKind: ProviderRequestBody['kind'],
  credential: keyof ModelPreviewRelayCredentials,
  maxResponseBytes: number,
): ModelPreviewRoute {
  if (!hasExactKeys(target, ['method', 'path', 'provider', 'scope'])) {
    throw new RelayRequestError(400, '模型开发中继请求目标未获允许。')
  }
  return {
    target: target as ProviderTarget,
    url,
    bodyKind,
    credential,
    maxResponseBytes,
  }
}

/** Applies the relay's closed origin plus method/path transport policy. */
export function resolveModelPreviewRoute(value: unknown): ModelPreviewRoute {
  const target = record(value)
  if (!hasExactKeys(target, ['method', 'path', 'provider', 'scope'])
    || typeof target.provider !== 'string'
    || typeof target.scope !== 'string'
    || typeof target.method !== 'string'
    || typeof target.path !== 'string') {
    throw new RelayRequestError(400, '模型开发中继请求目标未获允许。')
  }
  const policy = findProviderRoutePolicy(target as ProviderTarget)
  const credential = policy === undefined ? undefined : relayCredential(policy.provider)
  if (policy?.officialOrigin !== undefined && credential !== undefined) {
    return resolved(
      target,
      `${policy.officialOrigin}${String(target.path)}`,
      policy.bodyKind,
      credential,
      policy.maxResponseBytes,
    )
  }
  throw new RelayRequestError(400, '模型开发中继请求目标未获允许。')
}

function relayCredential(
  provider: ProviderTarget['provider'],
): keyof ModelPreviewRelayCredentials | undefined {
  if (provider === 'deepseek' || provider === 'glm' || provider === 'kimi') return provider
  return undefined
}

export function modelPreviewCredential(
  credentials: ModelPreviewRelayCredentials,
  route: ModelPreviewRoute,
): string {
  const credential = credentials[route.credential]?.trim()
  if (credential) return credential
  throw new RelayRequestError(503, '本地开发预览尚未配置该模型凭据。')
}
