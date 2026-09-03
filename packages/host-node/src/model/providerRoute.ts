// Provider request parsing and catalog lookup.
// The caller cannot supply an origin, credential, or header. Unknown fields are rejected before
// the target is matched against the closed route catalog in providerRouteCatalog.ts.

import {
  providerRoutePolicyMatches,
  type ProviderBodyKind,
  type ProviderMethod,
} from '@einfach-agent/ai'
import { modelRequestError } from './errors'
import { definedKeys, isJsonRecord } from './wireShape'
import {
  resolveProviderOrigin,
  type RegisteredProviderOrigins,
} from './registeredProviderOrigin'
import { normalizeConnectionProfileId } from './connectionProfile'
import { PROVIDER_ROUTES, type ProviderRouteEntry } from './providerRouteCatalog'
import {
  isModelProviderName,
  narrowProviderScope,
  providerAcceptsScope,
  type ModelProviderName,
  type ProviderScope,
} from './provider'

export type { RegisteredProviderOrigins } from './registeredProviderOrigin'
export type { ProviderBodyKind, ProviderMethod } from '@einfach-agent/ai'

/** 调用方能表达的全部内容。connectionId 只选 host profile；**没有 origin、Key 或 header**。 */
export interface ProviderTarget {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: string
  readonly connectionId?: string
}

/** 查表之后的结果。`url` 是本层拼出来的，不是调用方给的。 */
export interface ResolvedProviderTarget {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly url: string
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

/** Rust 的 `deny_unknown_fields`：`scope` 可缺席（有 serde default），其余三个必给。 */
const TARGET_REQUIRED_KEYS: readonly string[] = ['provider', 'method', 'path']
const TARGET_OPTIONAL_KEYS: readonly string[] = ['scope', 'connectionId']

function invalidRequest(): never {
  throw modelRequestError('invalidRequest')
}

function narrowMethod(value: unknown): ProviderMethod {
  if (value !== 'POST' && value !== 'DELETE') invalidRequest()
  return value
}

/**
 * 把一袋外部输入收窄成 `ProviderTarget`。形状不对一律是**格式无效**，不是「目标未获允许」——
 * 后者是策略拒绝，调用方该换个端点；前者是调用方压根没按契约发。
 *
 * `deny_unknown_fields` 的等价物是这里的键集合检查——**必须真的枚举键**，逐键读取天生忽略多余
 * 键，那正是要拦的东西。枚举用 `definedKeys` 而不是裸 `Object.keys`，理由见 wireShape.ts：
 * 两条传输路径对「键存在但值为 undefined」的表现不同。
 */
export function narrowProviderTarget(value: unknown): ProviderTarget {
  if (!isJsonRecord(value)) invalidRequest()
  const raw = value
  for (const key of definedKeys(raw)) {
    if (!TARGET_REQUIRED_KEYS.includes(key) && !TARGET_OPTIONAL_KEYS.includes(key)) {
      invalidRequest()
    }
  }
  // 判缺席同样只看值，不用 `'key' in raw`。
  for (const key of TARGET_REQUIRED_KEYS) {
    if (raw[key] === undefined) invalidRequest()
  }
  if (!isModelProviderName(raw.provider)) invalidRequest()
  if (typeof raw.path !== 'string') invalidRequest()
  if (raw.connectionId !== undefined && raw.provider !== 'openai-compat') invalidRequest()
  const connectionId = raw.connectionId === undefined
    ? undefined
    : normalizeConnectionProfileId(raw.connectionId)
  return {
    provider: raw.provider,
    scope: narrowProviderScope(raw.scope),
    method: narrowMethod(raw.method),
    path: raw.path,
    ...(connectionId === undefined ? {} : { connectionId }),
  }
}

function resolved(
  target: ProviderTarget,
  origin: string,
  bodyKind: ProviderBodyKind,
  maxResponseBytes: number,
): ResolvedProviderTarget {
  return {
    provider: target.provider,
    scope: target.scope,
    method: target.method,
    url: `${origin}${target.path}`,
    bodyKind,
    maxResponseBytes,
  }
}

function entryMatches(entry: ProviderRouteEntry, target: ProviderTarget): boolean {
  return providerRoutePolicyMatches(entry, target)
}

/**
 * 查表。命中且 origin 查得出即拼 URL，否则拒绝——**没有第三种出口**。
 *
 * `registeredOrigins` 默认是空对象：**不传就等于什么都没登记**，登记式条目一律落空。这个默认
 * 值是刻意的——它让「忘了把配置里的登记传进来」的后果是 fail closed（打不出去），而不是
 * fail open（打到某个默认地址）。同步且不碰文件系统同样是刻意的：白名单必须能在内存里穷举
 * 验证，掺进一次异步读盘之后它就不是一张能被测试穷举的表了。
 */
export function resolveProviderTarget(
  target: ProviderTarget,
  registeredOrigins: RegisteredProviderOrigins = {},
): ResolvedProviderTarget {
  // 表里每条的 (provider, scope) 本来就都在配对表内，这道判断因此不改变任何结果；留着是让
  // 「Kimi 只有 cn」这件事在两处保持同一个权威——将来往表里加一条写错作用域时，它是那条
  // 会当场拦下来的判据，而不是等到凭证读取时才发现没有对应的配置键。
  if (providerAcceptsScope(target.provider, target.scope)) {
    const entry = PROVIDER_ROUTES.find((candidate) => entryMatches(candidate, target))
    const origin = entry ? resolveProviderOrigin(entry.origin, registeredOrigins) : undefined
    if (entry && origin !== undefined) {
      return resolved(target, origin, entry.bodyKind, entry.maxResponseBytes)
    }
  }
  throw modelRequestError('targetNotAllowed')
}
