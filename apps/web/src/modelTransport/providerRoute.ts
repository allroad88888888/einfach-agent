// 前端这一侧的目标识别：把 adapter 拼出来的 URL 认回成 (provider, scope, method, path)
// ---------------------------------------------------------------------------
// **这不是安全边界**，后端的端点白名单才是（`packages/host-node/src/model/providerRoute.ts`）。
// 本层拼不出 origin 也送不出 origin：信封里只有身份/方法/路径与可选 profile ID，origin 由宿主
// 自己查表得出。这里认得
// 出来只是让请求发得出去，认不出来就当场拒绝、不浪费一次往返。
//
// openai-compat 的 origin 由用户登记，因此它的识别依据是**运行时那条登记值**
// （openAiCompatEndpoint.ts），没登记时它连候选都不是——与后端同向 fail closed。
// legacy adapter 用本地固定身份标记消除 origin 相同时的歧义；标记在 providerFetch 中消费，
// 不进入 wire。没有标记的请求只能按官方 origin 识别。

import {
  findProviderRoutePolicy,
  PROVIDER_OFFICIAL_ORIGINS,
  type ProviderMethod,
  type ProviderRequestBody,
  type ProviderTarget,
} from '@einfach-agent/ai'
import { openAiCompatOrigin } from './openAiCompatEndpoint'
import { openAiCompatConnection } from './openAiCompatRegistry'

export type ProviderRouteSpec = {
  bodyKind: ProviderRequestBody['kind']
  url: string
  maxResponseBytes: number
}

function invalidTarget(): never {
  throw new Error('模型请求目标未获允许')
}

function registeredOrigin(target: ProviderTarget): string | undefined {
  if (target.provider !== 'openai-compat') return undefined
  return target.connectionId === undefined
    ? openAiCompatOrigin()
    : openAiCompatConnection(target.connectionId)?.baseUrl
}

/** Resolves a generic target through the host's exact method/path security policy. */
export function providerRouteSpec(target: ProviderTarget): ProviderRouteSpec {
  const policy = findProviderRoutePolicy(target)
  if (policy === undefined) return invalidTarget()
  // 登记式 origin 仍由宿主配置持有；共享 policy 只声明这条 route 的传输形状。
  const origin = policy.officialOrigin ?? registeredOrigin(target)
  if (origin === undefined) return invalidTarget()
  return {
    bodyKind: policy.bodyKind,
    url: `${origin}${target.path}`,
    maxResponseBytes: policy.maxResponseBytes,
  }
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
 * 当前认得出的官方 origin 表。legacy openai-compat 不靠 URL 猜身份。
 */
function originBindings(): ProviderOriginBinding[] {
  return [
    PROVIDER_OFFICIAL_ORIGINS.deepseek,
    PROVIDER_OFFICIAL_ORIGINS.glm,
    PROVIDER_OFFICIAL_ORIGINS.kimi,
  ].map(({ origin, provider, scope }) => ({
    origin,
    identity: { provider, scope },
  }))
}

/** Converts only exact application endpoints into provider-owned method/path targets. */
export function providerTargetForRequest(
  input: RequestInfo | URL,
  method: ProviderMethod = 'POST',
  connectionId?: string,
  legacyOpenAiCompat = false,
): ProviderTarget {
  const url = urlText(input)
  if (legacyOpenAiCompat) {
    if (connectionId !== undefined) return invalidTarget()
    const candidate: ProviderTarget = {
      provider: 'openai-compat', scope: 'default', method,
      path: '/chat/completions',
    }
    if (providerRouteSpec(candidate).url !== url) return invalidTarget()
    return candidate
  }
  if (connectionId !== undefined) {
    const profile = openAiCompatConnection(connectionId)
    if (profile === undefined) return invalidTarget()
    const candidate: ProviderTarget = {
      provider: 'openai-compat', scope: 'default', method,
      path: '/chat/completions', connectionId,
    }
    if (providerRouteSpec(candidate).url !== url) return invalidTarget()
    return candidate
  }
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
