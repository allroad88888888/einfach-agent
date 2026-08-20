// 前端这一侧的目标识别：把 adapter 拼出来的 URL 认回成 (provider, scope, method, path)
// ---------------------------------------------------------------------------
// **这不是安全边界**，后端的端点白名单才是（`packages/host-node/src/model/providerRoute.ts`）。
// 本层拼不出 origin 也送不出 origin：信封里只有那四元组，origin 由宿主自己查表得出。这里认得
// 出来只是让请求发得出去，认不出来就当场拒绝、不浪费一次往返。
//
// openai-compat 的 origin 由用户登记，因此它的识别依据是**运行时那条登记值**
// （openAiCompatEndpoint.ts），没登记时它连候选都不是——与后端同向 fail closed。
// 前三家排在它前面是刻意的：登记一条恰好等于某家官方域名的地址时，请求会被认成**那一家**、
// 用那一家的 Key，而不是反过来让一条登记值顶掉内置厂商的身份。

import {
  DEEPSEEK_BASE_URL,
  GLM_BASE_URL,
  KIMI_CN_BASE_URL,
  type ProviderMethod,
  type ProviderRequestBody,
  type ProviderTarget,
} from '@einfach-agent/ai'
import { openAiCompatOrigin } from './openAiCompatEndpoint'

export const PROVIDER_RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/

export type ProviderRouteSpec = {
  bodyKind: ProviderRequestBody['kind']
  url: string
  maxResponseBytes: number
}

const CHAT_RESPONSE_LIMIT = 32 * 1024 * 1024
const FILE_RESPONSE_LIMIT = 4 * 1024 * 1024
const DELETE_RESPONSE_LIMIT = 1024 * 1024

function invalidTarget(): never {
  throw new Error('模型请求目标未获允许')
}

function safeFileDeletePath(path: string): boolean {
  const prefix = '/files/'
  return path.startsWith(prefix)
    && PROVIDER_RESOURCE_ID_PATTERN.test(path.slice(prefix.length))
}

/** Resolves a generic target through the host's exact method/path security policy. */
export function providerRouteSpec(target: ProviderTarget): ProviderRouteSpec {
  if (target.provider === 'deepseek'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    return {
      bodyKind: 'json',
      url: `${DEEPSEEK_BASE_URL}${target.path}`,
      maxResponseBytes: CHAT_RESPONSE_LIMIT,
    }
  }
  if (target.provider === 'glm'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    return {
      bodyKind: 'json',
      url: `${GLM_BASE_URL}${target.path}`,
      maxResponseBytes: CHAT_RESPONSE_LIMIT,
    }
  }
  if (target.provider === 'kimi' && target.scope === 'cn') {
    if (target.method === 'POST' && target.path === '/chat/completions') {
      return {
        bodyKind: 'json',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: CHAT_RESPONSE_LIMIT,
      }
    }
    if (target.method === 'POST' && target.path === '/files') {
      return {
        bodyKind: 'multipart',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: FILE_RESPONSE_LIMIT,
      }
    }
    if (target.method === 'DELETE' && safeFileDeletePath(target.path)) {
      return {
        bodyKind: 'none',
        url: `${KIMI_CN_BASE_URL}${target.path}`,
        maxResponseBytes: DELETE_RESPONSE_LIMIT,
      }
    }
  }
  // 登记式 origin：只有 chat 端点这一条（它的 adapter 不上传文件，因此没有 /files 与 DELETE），
  // 没登记时整条落空。这里的 `url` 只用于本地形状判断，真正上行的 URL 由后端拼。
  if (target.provider === 'openai-compat'
    && target.scope === 'default'
    && target.method === 'POST'
    && target.path === '/chat/completions') {
    const origin = openAiCompatOrigin()
    if (origin !== undefined) {
      return {
        bodyKind: 'json',
        url: `${origin}${target.path}`,
        maxResponseBytes: CHAT_RESPONSE_LIMIT,
      }
    }
  }
  return invalidTarget()
}

function urlText(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** 一条识别依据：这个 origin 命中时，请求属于哪一家。顺序即优先级，见文件头。 */
type ProviderOriginBinding = {
  origin: string
  identity: Pick<ProviderTarget, 'provider' | 'scope'>
}

/**
 * 当前认得出的 origin 表。前三家是常量，openai-compat 是**运行时**那条登记值——所以这张表
 * 每次现算，不能提到模块顶层求值一次（登记是启动之后才从后端 hydrate 回来的，
 * 提前求值等于永远认不出它）。
 */
function originBindings(): ProviderOriginBinding[] {
  const bindings: ProviderOriginBinding[] = [
    { origin: DEEPSEEK_BASE_URL, identity: { provider: 'deepseek', scope: 'default' } },
    { origin: GLM_BASE_URL, identity: { provider: 'glm', scope: 'default' } },
    { origin: KIMI_CN_BASE_URL, identity: { provider: 'kimi', scope: 'cn' } },
  ]
  const registered = openAiCompatOrigin()
  if (registered !== undefined) {
    bindings.push({ origin: registered, identity: { provider: 'openai-compat', scope: 'default' } })
  }
  return bindings
}

/** Converts only exact application endpoints into provider-owned method/path targets. */
export function providerTargetForRequest(
  input: RequestInfo | URL,
  method: ProviderMethod = 'POST',
): ProviderTarget {
  const url = urlText(input)
  const binding = originBindings().find((candidate) => url.startsWith(candidate.origin))
  if (!binding) return invalidTarget()
  const candidate = {
    ...binding.identity,
    method,
    path: url.slice(binding.origin.length),
  } as ProviderTarget
  providerRouteSpec(candidate)
  return candidate
}
