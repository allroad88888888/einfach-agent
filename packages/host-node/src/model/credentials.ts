// (供应商, 作用域) → 配置键 → 明文 Key
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_credentials.rs（已随 T1 删除）的**读取半边**（`credential_binding` /
// `normalized_key` / `configured_model_credential` / `active_model_credential`）。
//
// 写入半边（`model_credential_status` / `_set` / `_delete` 三条命令）不在本卡：issue 树把它们
// 划给 M4，那张卡要的是「与 `createTauriModelCredentialHost()` 同接口、status 只回
// `{ configured, source }`」。本文件把绑定与归一化导出，就是给 M4 复用的缝——三条命令要的是
// **同一张绑定表**，各写一份必然分叉。
//
// ═══ Key 只进不出 ═══
// 本文件是明文 Key 在 Node 侧唯一的出口，出口只有一个消费者：upstreamRequest.ts 的
// Authorization 头。除此之外：
//   · 不进返回值——`readActiveModelCredential` 的调用链上，Key 到 `fetch` 就没了。
//   · 不进错误——「没配置」这条错误只带**展示名**（`未配置 DeepSeek API Key`），不带键的任何片段，
//     也不带配置文件路径。
//   · 不进日志——本域全域没有任何日志语句，这是有意的：一条 `console.debug(request)` 就够了。

import { missingCredentialError, modelRequestError } from './errors'
import { normalizeApiKey, readModelCredentialKey } from './credentialSection'
import { providerAcceptsScope, providerDisplayName } from './provider'
import type { ModelProviderName, ProviderScope } from './provider'
import type { NodeHostInvokeOptions } from '../hostOptions'

/**
 * (供应商, 作用域) → `modelCredentials` 段里的键名。三对，与 Rust 的 match 一一对应。
 *
 * 键名里的作用域不是装饰：Kimi 的国内与国际站是两套 Key，键名带上作用域，换站点时不会拿着
 * 另一套 Key 去打。
 */
export function credentialConfigKey(
  provider: ModelProviderName,
  scope: ProviderScope,
): string {
  if (!providerAcceptsScope(provider, scope)) throw modelRequestError('scopeNotAllowed')
  return `${provider}:${scope}`
}

/**
 * Rust `normalized_key`：去掉首尾空白，空串与超长（>1024 字节）都算「没配置」。
 *
 * 空白后为空**必须**当没配置：配置文件里留一个 `"deepseek:default": "  "` 是常见的手写残留，
 * 把它当成有效 Key 会让请求带着一个空 Bearer 打上去，换回一条供应商的 401，而用户看到的提示
 * 与「没配置」完全不同。
 */
export { normalizeApiKey }

/** Rust `configured_model_credential`：读配置里那一条，归一化之后还在就算配置了。 */
export async function readConfiguredModelCredential(
  options: NodeHostInvokeOptions,
  provider: ModelProviderName,
  scope: ProviderScope,
): Promise<string | undefined> {
  const configKey = credentialConfigKey(provider, scope)
  return normalizeApiKey(await readModelCredentialKey(options, configKey))
}

/**
 * Rust `active_model_credential`：没配置就是受控失败。
 *
 * ⚠️ 返回值是**明文 Key**。见文件头「Key 只进不出」。
 */
export async function readActiveModelCredential(
  options: NodeHostInvokeOptions,
  provider: ModelProviderName,
  scope: ProviderScope,
): Promise<string> {
  const credential = await readConfiguredModelCredential(options, provider, scope)
  if (credential === undefined) {
    throw missingCredentialError(providerDisplayName(provider))
  }
  return credential
}
