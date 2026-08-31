import type { ModelProviderName, ProviderScope } from './provider'
import {
  OPENAI_COMPAT_ORIGIN,
  type ProviderOrigin,
} from './registeredProviderOrigin'
import type { ProviderBodyKind, ProviderMethod } from './providerRoute'

export interface ProviderRouteEntry {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: string | RegExp
  readonly origin: ProviderOrigin
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

const CHAT_RESPONSE_LIMIT = 32 * 1024 * 1024
const FILE_RESPONSE_LIMIT = 4 * 1024 * 1024
const DELETE_RESPONSE_LIMIT = 1024 * 1024

const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
const GLM_ORIGIN = 'https://open.bigmodel.cn/api/paas/v4'
const KIMI_CN_ORIGIN = 'https://api.moonshot.cn/v1'

const DEEPSEEK_FILE_DELETE_PATH = /^\/files\/file-api-[A-Za-z0-9._-]{1,247}$/
const KIMI_FILE_DELETE_PATH = /^\/files\/[A-Za-z0-9._-]{1,256}$/

/**
 * The host's complete origin + method/path policy. Every entry fixes its request body kind and
 * response limit; regex paths are anchored so traversal, nested segments, and queries fail closed.
 * DeepSeek file deletion additionally requires the upstream `file-api-` ID namespace.
 */
export const PROVIDER_ROUTES: readonly ProviderRouteEntry[] = [
  {
    provider: 'deepseek',
    scope: 'default',
    method: 'POST',
    path: '/chat/completions',
    origin: DEEPSEEK_ORIGIN,
    bodyKind: 'json',
    maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'deepseek',
    scope: 'default',
    method: 'POST',
    path: '/files',
    origin: DEEPSEEK_ORIGIN,
    bodyKind: 'multipart',
    maxResponseBytes: FILE_RESPONSE_LIMIT,
  },
  {
    provider: 'deepseek',
    scope: 'default',
    method: 'DELETE',
    path: DEEPSEEK_FILE_DELETE_PATH,
    origin: DEEPSEEK_ORIGIN,
    bodyKind: 'none',
    maxResponseBytes: DELETE_RESPONSE_LIMIT,
  },
  {
    provider: 'glm',
    scope: 'default',
    method: 'POST',
    path: '/chat/completions',
    origin: GLM_ORIGIN,
    bodyKind: 'json',
    maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi',
    scope: 'cn',
    method: 'POST',
    path: '/chat/completions',
    origin: KIMI_CN_ORIGIN,
    bodyKind: 'json',
    maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi',
    scope: 'cn',
    method: 'POST',
    path: '/files',
    origin: KIMI_CN_ORIGIN,
    bodyKind: 'multipart',
    maxResponseBytes: FILE_RESPONSE_LIMIT,
  },
  {
    provider: 'kimi',
    scope: 'cn',
    method: 'DELETE',
    path: KIMI_FILE_DELETE_PATH,
    origin: KIMI_CN_ORIGIN,
    bodyKind: 'none',
    maxResponseBytes: DELETE_RESPONSE_LIMIT,
  },
  {
    provider: 'openai-compat',
    scope: 'default',
    method: 'POST',
    path: '/chat/completions',
    origin: OPENAI_COMPAT_ORIGIN,
    bodyKind: 'json',
    maxResponseBytes: CHAT_RESPONSE_LIMIT,
  },
]
