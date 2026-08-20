// 供应商与作用域这两个闭合枚举，以及「哪些 (供应商, 作用域) 组合成立」
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_provider.rs（已随 T1 删除）。
//
// 单独成文件而不是并进 providerRoute.ts，理由与 Rust 侧分成两个文件一样：**这一层不知道任何
// URL**。它只回答「这两个词合法吗、它们能配对吗、这个供应商对用户叫什么名字」。端点白名单
// （providerRoute.ts）与凭证绑定（credentials.ts）是两个各自独立的消费者，它们都从这里取
// 「合法的一对」，于是「Kimi 只有 cn 作用域」这件事只写一遍。
//
// 【为什么是闭合枚举而不是随便一个字符串】
// 这两个值最终决定去哪个 origin、读哪个配置键。放开成任意字符串时，多出来的取值不会立刻出错，
// 而是在下游某个 match 里落进兜底分支——于是「拼错了 provider」和「这个组合不被允许」变成同一
// 句话，排查时分不出是调用方写错还是策略拒绝。

import { modelRequestError } from './errors'

/**
 * Rust `ModelProvider`，serde `rename_all = "lowercase"`。
 *
 * `openai-compat` **没有 Rust 对应项**：它是 agent-ai 的第四家 vendor（`OPENAI_COMPAT_VENDOR_ID`），
 * 桌面宿主退场之后才补进受限传输。它与前三家在本文件这一层完全同格——一个合法的供应商名、
 * 一个作用域配对——差别只在端点白名单那里：前三家的 origin 是常量，它的 origin 从配置里那条
 * 用户显式登记的 base URL 查（见 openAiCompatBaseUrl.ts 的文件头）。
 */
export type ModelProviderName = 'deepseek' | 'glm' | 'kimi' | 'openai-compat'

/** Rust `ProviderScope`，serde `rename_all = "lowercase"`，`Default` 是 serde 的 default。 */
export type ProviderScope = 'default' | 'cn'

const PROVIDER_NAMES: readonly string[] = ['deepseek', 'glm', 'kimi', 'openai-compat']
const SCOPE_NAMES: readonly string[] = ['default', 'cn']

/**
 * 展示名。只用于 `未配置 X API Key` 这一句用户可见文案（Rust `display_name`）。
 *
 * openai-compat 刻意不叫「OpenAI」：挂在它后面的是用户自建网关或任意第三方兼容端点，
 * 报一个厂商名会让「未配置 OpenAI API Key」指向一个用户根本没在用的服务。
 */
const DISPLAY_NAMES: Record<ModelProviderName, string> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  kimi: 'Kimi',
  'openai-compat': 'OpenAI 兼容端点',
}

export function isModelProviderName(value: unknown): value is ModelProviderName {
  return typeof value === 'string' && PROVIDER_NAMES.includes(value)
}

export function isProviderScope(value: unknown): value is ProviderScope {
  return typeof value === 'string' && SCOPE_NAMES.includes(value)
}

export function providerDisplayName(provider: ModelProviderName): string {
  return DISPLAY_NAMES[provider]
}

/**
 * 固定的 (供应商, 作用域) 配对表（Rust `accepts_scope`）。
 *
 * 这是一张**白名单**而不是「除了某几个都行」：Kimi 只在 cn、DeepSeek / GLM / openai-compat
 * 只在 default。多出来的组合（如 `kimi` + `default`）既没有 origin 也没有配置键，放行只会让
 * 请求带着一个不存在的凭证键去打一个不存在的地址。
 *
 * openai-compat 只给 default 一个作用域，是因为作用域表达的是「同一家的哪个站点」（Kimi 国内/
 * 国际是两套 Key），而它的站点由登记的 base URL 本身回答——再开第二个作用域等于让同一件事有
 * 两个说法，且两个作用域会各自对应一条要维护的登记项。
 */
export function providerAcceptsScope(provider: ModelProviderName, scope: ProviderScope): boolean {
  if (provider === 'kimi') return scope === 'cn'
  return scope === 'default'
}

/** 收窄一个来自外部输入的作用域值；缺席按 serde 的 `#[serde(default)]` 当 `default`。 */
export function narrowProviderScope(value: unknown): ProviderScope {
  if (value === undefined) return 'default'
  if (!isProviderScope(value)) throw modelRequestError('invalidRequest')
  return value
}
