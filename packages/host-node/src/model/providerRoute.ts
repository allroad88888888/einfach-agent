// 端点白名单：一次请求到底允许打到哪个 URL
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_provider_route.rs，**逐条对齐**（5 条，见下）。
//
// ═══ 这张表是本域安全性的全部 ═══
// 没有它，这一层就是一个开放代理：任何能发出 `model_provider_request` 的东西都能借用户的
// API Key 打**任意** URL，而 Key 是宿主自己从配置里取的、调用方看不见也拦不住。所以：
//   · origin **不来自调用方**。调用方只能给 (provider, scope, method, path)，origin 由本表按
//     那四元组查出来，再拼成 `origin + path`。
//   · path 不是自由字符串：四条是**字面量全等**，第五条（删除上传文件）走一个只认
//     `[A-Za-z0-9._-]{1,256}` 的资源 ID 判据——`..`、`?`、`/` 全部落选，于是既跳不出 `/files/`
//     这一层，也挂不上 query。
//   · 收窄 target 时**拒绝多余字段**（Rust 的 `deny_unknown_fields`）。少了这条，攻击面是往
//     target 里塞一个 `url`：今天没人读它，哪天有人顺手读了就直接变成开放代理。Rust 侧为这一条
//     专门留了 `rejects_unknown_target_fields` 测试，Node 侧同样钉住。
//
// 【新增端点的门槛】改这张表 = 扩大 Key 的使用面。要加一条得同时回答：这个端点收什么 body
// （bodyKind 决定 requestBody.ts 走哪条校验）、响应上限多少（maxResponseBytes 是内存保护）。
// 三个字段少写一个都不会编译失败，但会静默留一个没有上限的洞。

import { modelRequestError } from './errors'
import { definedKeys, isJsonRecord } from './wireShape'
import {
  isModelProviderName,
  narrowProviderScope,
  providerAcceptsScope,
  type ModelProviderName,
  type ProviderScope,
} from './provider'

/** Rust `ProviderMethod`，serde 显式 rename 成大写。 */
export type ProviderMethod = 'POST' | 'DELETE'

/** Rust `ProviderBodyKind`。决定 requestBody.ts 对这次请求体走哪条校验。 */
export type ProviderBodyKind = 'none' | 'json' | 'multipart'

/** 调用方能表达的全部内容：供应商、作用域、方法、路径。**没有 origin，也没有 header**。 */
export interface ProviderTarget {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: string
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

const CHAT_RESPONSE_LIMIT = 32 * 1024 * 1024
const FILE_RESPONSE_LIMIT = 4 * 1024 * 1024
const DELETE_RESPONSE_LIMIT = 1024 * 1024

const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
const GLM_ORIGIN = 'https://open.bigmodel.cn/api/paas/v4'
const KIMI_CN_ORIGIN = 'https://api.moonshot.cn/v1'

/** Rust `valid_resource_id`：非空、≤256 字节、只含 ASCII 字母数字与 `.` `_` `-`。 */
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/

/** Rust `valid_file_delete_path`：必须是 `/files/<resource-id>`，且只有那一层。 */
function isValidFileDeletePath(path: string): boolean {
  const prefix = '/files/'
  return path.startsWith(prefix) && RESOURCE_ID_PATTERN.test(path.slice(prefix.length))
}

/** Rust 的 `deny_unknown_fields`：`scope` 可缺席（有 serde default），其余三个必给。 */
const TARGET_REQUIRED_KEYS: readonly string[] = ['provider', 'method', 'path']
const TARGET_OPTIONAL_KEYS: readonly string[] = ['scope']

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
  return {
    provider: raw.provider,
    scope: narrowProviderScope(raw.scope),
    method: narrowMethod(raw.method),
    path: raw.path,
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

/** 一条白名单条目。`path` 是字面量全等或一条判据函数，两者都不接受任意路径。 */
interface ProviderRouteEntry {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: string | ((path: string) => boolean)
  readonly origin: string
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

/**
 * 宿主的封闭 origin + 方法/路径策略。**五条，与 `model_provider_route.rs` 的五个 match 臂
 * 一一对应、同序**。其余一切组合落进兜底：`模型请求目标未获允许`。
 *
 * 第 4、5 条是 Kimi 的文件上传与清理端点。**本层只搬运**：什么时候上传、`ms://` 引用怎么编码、
 * 什么时候删，全在 `packages/agent-ai` 的 adapter 里（CLAUDE.md：Tauri 只保持 provider-neutral
 * 受限传输）。把那套语义搬进宿主，等于让宿主认识某个供应商的业务流程。
 */
const PROVIDER_ROUTES: readonly ProviderRouteEntry[] = [
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
    path: isValidFileDeletePath,
    origin: KIMI_CN_ORIGIN,
    bodyKind: 'none',
    maxResponseBytes: DELETE_RESPONSE_LIMIT,
  },
]

function entryMatches(entry: ProviderRouteEntry, target: ProviderTarget): boolean {
  return (
    entry.provider === target.provider
    && entry.scope === target.scope
    && entry.method === target.method
    && (typeof entry.path === 'string' ? entry.path === target.path : entry.path(target.path))
  )
}

/** 查表。命中即拼 URL，未命中即拒绝——**没有第三种出口**。 */
export function resolveProviderTarget(target: ProviderTarget): ResolvedProviderTarget {
  // 表里每条的 (provider, scope) 本来就都在配对表内，这道判断因此不改变任何结果；留着是让
  // 「Kimi 只有 cn」这件事在两处保持同一个权威——将来往表里加一条写错作用域时，它是那条
  // 会当场拦下来的判据，而不是等到凭证读取时才发现没有对应的配置键。
  if (providerAcceptsScope(target.provider, target.scope)) {
    const entry = PROVIDER_ROUTES.find((candidate) => entryMatches(candidate, target))
    if (entry) return resolved(target, entry.origin, entry.bodyKind, entry.maxResponseBytes)
  }
  throw modelRequestError('targetNotAllowed')
}
