import type { ProviderRequestBody, ProviderTarget } from '../packages/agent-ai/src/providerTransport'
import { RelayRequestError } from './model-preview-relay-error'

export const PROVIDER_RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/
const DEEPSEEK_FILE_ID_PATTERN = /^file-api-[A-Za-z0-9._-]{1,247}$/

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

const CHAT_RESPONSE_LIMIT = 32 * 1024 * 1024
const FILE_RESPONSE_LIMIT = 4 * 1024 * 1024
const DELETE_RESPONSE_LIMIT = 1024 * 1024

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

function safeFileDeletePath(
  path: unknown,
  idPattern = PROVIDER_RESOURCE_ID_PATTERN,
): path is string {
  if (typeof path !== 'string' || !path.startsWith('/files/')) return false
  return idPattern.test(path.slice('/files/'.length))
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
  if (target.provider === 'deepseek' && target.scope === 'default') {
    if (target.method === 'POST' && target.path === '/chat/completions') {
      return resolved(
        target, 'https://api.deepseek.com/chat/completions',
        'json', 'deepseek', CHAT_RESPONSE_LIMIT,
      )
    }
    if (target.method === 'POST' && target.path === '/files') {
      return resolved(
        target, 'https://api.deepseek.com/files',
        'multipart', 'deepseek', FILE_RESPONSE_LIMIT,
      )
    }
    if (target.method === 'DELETE'
      && safeFileDeletePath(target.path, DEEPSEEK_FILE_ID_PATTERN)) {
      return resolved(
        target, `https://api.deepseek.com${target.path}`,
        'none', 'deepseek', DELETE_RESPONSE_LIMIT,
      )
    }
  }
  if (target.provider === 'glm'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    return resolved(
      target, 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      'json', 'glm', CHAT_RESPONSE_LIMIT,
    )
  }
  if (target.provider === 'kimi' && target.scope === 'cn') {
    if (target.method === 'POST' && target.path === '/chat/completions') {
      return resolved(
        target, 'https://api.moonshot.cn/v1/chat/completions',
        'json', 'kimi', CHAT_RESPONSE_LIMIT,
      )
    }
    if (target.method === 'POST' && target.path === '/files') {
      return resolved(
        target, 'https://api.moonshot.cn/v1/files', 'multipart', 'kimi', FILE_RESPONSE_LIMIT,
      )
    }
    if (target.method === 'DELETE' && safeFileDeletePath(target.path)) {
      return resolved(
        target, `https://api.moonshot.cn/v1${target.path}`,
        'none', 'kimi', DELETE_RESPONSE_LIMIT,
      )
    }
  }
  throw new RelayRequestError(400, '模型开发中继请求目标未获允许。')
}

export function modelPreviewCredential(
  credentials: ModelPreviewRelayCredentials,
  route: ModelPreviewRoute,
): string {
  const credential = credentials[route.credential]?.trim()
  if (credential) return credential
  throw new RelayRequestError(503, '本地开发预览尚未配置该模型凭据。')
}
