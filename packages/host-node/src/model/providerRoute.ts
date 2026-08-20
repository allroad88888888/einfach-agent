// 端点白名单：一次请求到底允许打到哪个 URL
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_provider_route.rs（已随 T1 删除），前 5 条**逐条对齐**；
// 第 6 条（openai-compat）无 Rust 出处，是桌面宿主退场之后补的第四家，见下面「登记式 origin」。
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
//
// ═══ 登记式 origin：openai-compat 那一条为什么长得不一样 ═══
// 前 5 条的 origin 是常量，因为那三家有厂商官方接入点。openai-compat 没有——它的 baseUrl 由
// **用户填**，「精确匹配一个已知 origin」这个前提在它身上不成立。替代约束是**显式许可清单**：
// origin 依旧不来自调用方，而是宿主从自己的配置文件里读那唯一一条用户显式登记的 base URL，
// 由 `resolveProviderTarget` 的第二个参数传进来（`registeredOrigins`）。三件事因此仍然成立：
//   · 调用方**没有**表达 origin 的字段（`ProviderTarget` 里压根没有那个键，且多余键会被拒）；
//   · 没登记过 = 没有 origin = 目标未获允许，**fail closed**，不存在「猜一个默认值」的分支；
//   · 拿到的登记值仍要**当场过一遍判据**（`normalize`，见 openAiCompatBaseUrl.ts）。传进来的
//     值来自一份用户可以手改的 JSON，不是可信输入；本表是最后一道，它自己不判就没人判了。
// 方法与路径这一维**没有放宽**：openai-compat 只有 `POST /chat/completions` 一条，字面量全等，
// 与前三家的 chat 端点同款。它的 adapter 不上传文件，因此没有 `/files` 与 DELETE。

import { modelRequestError } from './errors'
import { normalizeOpenAiCompatBaseUrl } from './openAiCompatBaseUrl'
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

/**
 * 宿主查得出的登记式 origin。**只有一条**，也只该有一条：多一条就说明又有一家没有官方接入点，
 * 而每一条都要自带「凭什么这个值能用」的判据（下面 `RegisteredOrigin.normalize`）。
 *
 * 值从哪来不是本文件的事（`openAiCompatEndpoint.ts` 从 `config.json` 读），本文件只负责
 * 「拿到之后凭什么敢用」。
 */
export interface RegisteredProviderOrigins {
  readonly openAiCompat?: string
}

/**
 * 一条登记式 origin 的引用：指向 `registeredOrigins` 里的哪个槽，以及用哪条判据验它。
 *
 * `normalize` 是必填字段而不是可选项：新增第二条登记式 origin 的人必须当场说出它的判据，
 * 而不是复用别人的、或者干脆不判。返回 `undefined` = 这个值不能用 = 目标未获允许。
 */
interface RegisteredOrigin {
  readonly registered: keyof RegisteredProviderOrigins
  readonly normalize: (value: string) => string | undefined
}

/** 一条白名单条目。`path` 是字面量全等或一条判据函数，两者都不接受任意路径。 */
interface ProviderRouteEntry {
  readonly provider: ModelProviderName
  readonly scope: ProviderScope
  readonly method: ProviderMethod
  readonly path: string | ((path: string) => boolean)
  /** 常量 origin（前 5 条），或一条登记式 origin 的引用（openai-compat）。 */
  readonly origin: string | RegisteredOrigin
  readonly bodyKind: ProviderBodyKind
  readonly maxResponseBytes: number
}

/** openai-compat 的登记式 origin 引用。判据与写入侧共用同一个函数，见 openAiCompatBaseUrl.ts。 */
const OPENAI_COMPAT_ORIGIN: RegisteredOrigin = {
  registered: 'openAiCompat',
  normalize: normalizeOpenAiCompatBaseUrl,
}

/**
 * 宿主的封闭 origin + 方法/路径策略。**前五条与 `model_provider_route.rs` 的五个 match 臂
 * 一一对应、同序**，第六条是 openai-compat 的 chat 端点。其余一切组合落进兜底：
 * `模型请求目标未获允许`。
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

function entryMatches(entry: ProviderRouteEntry, target: ProviderTarget): boolean {
  return (
    entry.provider === target.provider
    && entry.scope === target.scope
    && entry.method === target.method
    && (typeof entry.path === 'string' ? entry.path === target.path : entry.path(target.path))
  )
}

/**
 * 取一条命中条目的 origin。常量条目直接给；登记式条目查槽位、**并当场过一遍它自己的判据**。
 *
 * 没登记、或登记的值不合规，都回 `undefined` —— 对调用方是同一件事（这个目标现在不可用），
 * 而分成两句话会让「你还没登记」和「你登记的那条不合规」共用一条不该回显地址的错误消息。
 * 真正需要区分这两者的是设置面板，它走的是登记命令那条路，那里说得清楚。
 */
function entryOrigin(
  entry: ProviderRouteEntry,
  registeredOrigins: RegisteredProviderOrigins,
): string | undefined {
  if (typeof entry.origin === 'string') return entry.origin
  const value = registeredOrigins[entry.origin.registered]
  if (value === undefined) return undefined
  return entry.origin.normalize(value)
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
    const origin = entry ? entryOrigin(entry, registeredOrigins) : undefined
    if (entry && origin !== undefined) {
      return resolved(target, origin, entry.bodyKind, entry.maxResponseBytes)
    }
  }
  throw modelRequestError('targetNotAllowed')
}
