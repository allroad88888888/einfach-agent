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

/** Rust `ModelProvider`，serde `rename_all = "lowercase"`。 */
export type ModelProviderName = 'deepseek' | 'glm' | 'kimi'

/** Rust `ProviderScope`，serde `rename_all = "lowercase"`，`Default` 是 serde 的 default。 */
export type ProviderScope = 'default' | 'cn'

const PROVIDER_NAMES: readonly string[] = ['deepseek', 'glm', 'kimi']
const SCOPE_NAMES: readonly string[] = ['default', 'cn']

/** 展示名。只用于 `未配置 X API Key` 这一句用户可见文案（Rust `display_name`）。 */
const DISPLAY_NAMES: Record<ModelProviderName, string> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  kimi: 'Kimi',
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
 * 这是一张**白名单**而不是「除了某几个都行」：Kimi 只在 cn、DeepSeek 与 GLM 只在 default。
 * 多出来的组合（如 `kimi` + `default`）既没有 origin 也没有配置键，放行只会让请求带着一个
 * 不存在的凭证键去打一个不存在的地址。
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
